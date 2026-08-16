import {
  compileConfiguration,
  createEmptyIr,
  getSquidAdapter,
  IR_VERSION,
  WEEKDAYS,
  type CompiledConfiguration,
  type ConfigurationIr,
  type DestinationMatcher,
  type IdentityGroupRef,
  type IdentityMatcher,
  type Listener,
  type PolicyRule,
  type ScheduleMatcher,
  type SourceMatcher,
  type Weekday,
} from '@scp/shared';
import type { Db } from '../db/pool.js';
import type { AuthenticationProviderRegistry } from '../providers/registry.js';
import { decryptSecret } from '../security/secrets.js';

/**
 * Builds the configuration IR from the database and compiles it.
 *
 * Everything the policy engine and the Squid compiler need is resolved here -
 * network ids become CIDR lists, group ids become group references, logical
 * groups get expanded. Downstream code never touches the database.
 */

interface RuleRow {
  id: string;
  position: number;
  name: string;
  description: string | null;
  enabled: boolean;
  action: 'ALLOW' | 'DENY';
  source: unknown;
  identity: unknown;
  destination: unknown;
  schedule: unknown;
  scope: 'GLOBAL' | 'NODE_GROUP';
  scope_group_ids: string[];
}

export interface IrBuildResult {
  ir: ConfigurationIr;
  /** Problems found while resolving references, e.g. a deleted network. */
  issues: string[];
}

export interface BuildIrOptions {
  /** Build the configuration for one node. Omitted for a fleet-wide preview. */
  nodeId?: string;
}

export async function buildIr(
  db: Db,
  registry: AuthenticationProviderRegistry,
  options: BuildIrOptions = {},
): Promise<IrBuildResult> {
  const issues: string[] = [];

  // Which node, and therefore which group, this configuration is for. Without
  // a node only what applies everywhere is included, which is what the
  // fleet-wide preview should show.
  let node: { id: string; name: string; groupId: string | null; groupName: string | null } | null = null;
  if (options.nodeId) {
    const { rows } = await db.query<{ id: string; name: string; group_id: string | null; group_name: string | null }>(
      `select n.id, n.name, n.group_id, g.name as group_name
       from proxy_nodes n left join node_groups g on g.id = n.group_id
       where n.id = $1`,
      [options.nodeId],
    );
    const row = rows[0];
    if (row) {
      node = { id: row.id, name: row.name, groupId: row.group_id, groupName: row.group_name };
    }
  }
  const nodeGroupId = node?.groupId ?? null;


  const { rows: configRows } = await db.query<{
    mode: 'DISABLED' | 'OPTIONAL' | 'REQUIRED';
    default_access: 'ALLOW' | 'DENY';
    realm: string;
  }>('select mode, default_access, realm from proxy_auth_config where id = 1');
  const authConfig = configRows[0] ?? { mode: 'DISABLED' as const, default_access: 'DENY' as const, realm: 'Squid Proxy' };

  const { rows: networkRows } = await db.query<{ id: string; name: string; cidrs: string[] }>(
    'select id, name, cidrs from networks',
  );
  const networksById = new Map(networkRows.map((row) => [row.id, row]));

  const { rows: groupRows } = await db.query<{
    id: string;
    name: string;
    source: 'LOCAL' | 'EXTERNAL' | 'LOGICAL';
    provider_key: string | null;
  }>('select id, name, source, provider_key from proxy_groups');
  const groupsById = new Map(groupRows.map((row) => [row.id, row]));

  const { rows: logicalMemberRows } = await db.query<{ logical_group_id: string; member_group_id: string }>(
    'select logical_group_id, member_group_id from logical_group_members',
  );
  const logicalMembers = new Map<string, string[]>();
  for (const row of logicalMemberRows) {
    const list = logicalMembers.get(row.logical_group_id) ?? [];
    list.push(row.member_group_id);
    logicalMembers.set(row.logical_group_id, list);
  }

  const { rows: userRows } = await db.query<{ id: string; username: string }>(
    'select id, username from proxy_users',
  );
  const usersById = new Map(userRows.map((row) => [row.id, row.username]));

  const { rows: membershipRows } = await db.query<{ group_name: string; username: string }>(
    `select g.name as group_name, u.username as username
     from proxy_user_groups ug
     join proxy_groups g on g.id = ug.group_id and g.source = 'LOCAL'
     join proxy_users u on u.id = ug.user_id and u.status = 'ACTIVE'
     order by g.name, u.username`,
  );
  const localGroupMembers: Record<string, string[]> = {};
  for (const row of membershipRows) {
    (localGroupMembers[row.group_name] ??= []).push(row.username);
  }

  // Listener profiles are the source of truth (ADR 0003). A profile with no
  // group applies everywhere; otherwise it belongs to the node's group. Without
  // a node the fleet-wide preview shows the profiles that apply to everyone.
  const { rows: listenerRows } = await db.query<{
    id: string;
    name: string;
    address: string;
    port: number;
    mode: 'FORWARD' | 'INTERCEPT';
    enabled: boolean;
    authentication_mode: 'INHERIT' | 'DISABLED' | 'OPTIONAL' | 'REQUIRED';
    source_network_ids: string[];
    group_id: string | null;
  }>(
    `select id, name, address, port, mode, enabled, authentication_mode, source_network_ids, group_id
     from listener_profiles
     where group_id is null or group_id = $1
     order by port, name`,
    [nodeGroupId],
  );

  const listeners: Listener[] = listenerRows.map((row) => ({
    id: row.id,
    // Squid needs a port name that is stable and unique within the file.
    key: `${row.name}-${row.port}`,
    name: row.name,
    address: row.address,
    port: row.port,
    mode: row.mode,
    enabled: row.enabled,
    // INHERIT is resolved here so nothing downstream has to know the hierarchy
    // existed.
    authentication: row.authentication_mode === 'INHERIT' ? authConfig.mode : row.authentication_mode,
    inheritsAuthentication: row.authentication_mode === 'INHERIT',
    sourceNetworks: (row.source_network_ids ?? [])
      .map((id) => networksById.get(id))
      .filter((network): network is { id: string; name: string; cidrs: string[] } => Boolean(network)),
  }));


  const { rows: ruleRows } = await db.query<RuleRow>(
    `select id, position, name, description, enabled, action, source, identity, destination, schedule, scope, scope_group_ids
     from access_rules
     where scope = 'GLOBAL' or ($1::uuid is not null and $1 = any(scope_group_ids))
     order by position, id`,
    [nodeGroupId],
  );

  const toGroupRef = (groupId: string, depth = 0): IdentityGroupRef | null => {
    const group = groupsById.get(groupId);
    if (!group) return null;
    if (group.source === 'LOGICAL') {
      if (depth > 4) return null;
      const expandsTo = (logicalMembers.get(group.id) ?? [])
        .map((memberId) => toGroupRef(memberId, depth + 1))
        .filter((ref): ref is IdentityGroupRef => ref !== null);
      return { source: 'LOGICAL', name: group.name, providerKey: null, expandsTo };
    }
    return { source: group.source, name: group.name, providerKey: group.provider_key };
  };

  const rules: PolicyRule[] = ruleRows.map((row) => ({
    id: row.id,
    position: row.position,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    action: row.action,
    source: resolveSource(row.source, networksById, row.name, issues),
    identity: resolveIdentity(row.identity, usersById, toGroupRef, row.name, issues),
    destination: resolveDestination(row.destination),
    schedule: resolveSchedule(row.schedule),
    scope:
      row.scope === 'NODE_GROUP'
        ? { kind: 'NODE_GROUP' as const, groupIds: row.scope_group_ids ?? [], groupNames: [] }
        : { kind: 'GLOBAL' as const },
  }));

  const ir = createEmptyIr({
    irVersion: IR_VERSION,
    generatedAt: new Date().toISOString(),
    node,
    authentication: {
      mode: authConfig.mode,
      realm: authConfig.realm,
      providers: registry.enabled().map((adapter) => adapter.toIr()),
      localGroupMembers,
    },
    defaultAccess: authConfig.default_access,
    listeners,
    rules,
  });

  return { ir, issues };
}

function resolveSource(
  raw: unknown,
  networksById: Map<string, { id: string; name: string; cidrs: string[] }>,
  ruleName: string,
  issues: string[],
): SourceMatcher {
  const value = (raw ?? {}) as { kind?: string; networkIds?: string[] };
  if (value.kind !== 'NETWORKS') return { kind: 'ANY' };
  const networks = [];
  for (const id of value.networkIds ?? []) {
    const network = networksById.get(id);
    if (!network) {
      issues.push(`Rule "${ruleName}" refers to a network that no longer exists.`);
      continue;
    }
    networks.push({ id: network.id, name: network.name, cidrs: network.cidrs });
  }
  return networks.length > 0 ? { kind: 'NETWORKS', networks } : { kind: 'ANY' };
}

function resolveIdentity(
  raw: unknown,
  usersById: Map<string, string>,
  toGroupRef: (id: string) => IdentityGroupRef | null,
  ruleName: string,
  issues: string[],
): IdentityMatcher {
  const value = (raw ?? {}) as { kind?: string; userIds?: string[]; groupIds?: string[] };
  switch (value.kind) {
    case 'AUTHENTICATED':
      return { kind: 'AUTHENTICATED' };
    case 'UNAUTHENTICATED':
      return { kind: 'UNAUTHENTICATED' };
    case 'USER': {
      const users = [];
      for (const id of value.userIds ?? []) {
        const username = usersById.get(id);
        if (!username) {
          issues.push(`Rule "${ruleName}" refers to a proxy user that no longer exists.`);
          continue;
        }
        users.push({ providerKey: null, username });
      }
      return { kind: 'USER', users };
    }
    case 'GROUP': {
      const groups = [];
      for (const id of value.groupIds ?? []) {
        const ref = toGroupRef(id);
        if (!ref) {
          issues.push(`Rule "${ruleName}" refers to a group that no longer exists.`);
          continue;
        }
        groups.push(ref);
      }
      return { kind: 'GROUP', groups };
    }
    default:
      return { kind: 'ANY' };
  }
}

function resolveDestination(raw: unknown): DestinationMatcher {
  const value = (raw ?? {}) as {
    kind?: string;
    domains?: string[];
    cidrs?: string[];
    ports?: number[];
  };
  if (value.kind !== 'SPECIFIC') return { kind: 'ANY' };
  return {
    kind: 'SPECIFIC',
    domains: value.domains ?? [],
    cidrs: value.cidrs ?? [],
    ports: value.ports ?? [],
  };
}

function resolveSchedule(raw: unknown): ScheduleMatcher {
  const value = (raw ?? {}) as {
    kind?: string;
    days?: string[];
    startMinutes?: number;
    endMinutes?: number;
  };
  if (value.kind !== 'WINDOW') return { kind: 'ALWAYS' };
  const days = (value.days ?? []).filter((day): day is Weekday =>
    (WEEKDAYS as readonly string[]).includes(day),
  );
  return {
    kind: 'WINDOW',
    days,
    startMinutes: value.startMinutes ?? 0,
    endMinutes: value.endMinutes ?? 24 * 60,
  };
}

export interface CompileResult extends CompiledConfiguration {
  ir: ConfigurationIr;
  issues: string[];
}

export async function compileCurrentConfiguration(
  db: Db,
  registry: AuthenticationProviderRegistry,
  options: {
    adapterId?: string;
    generatorVersion?: string;
    /**
     * Include provider bind passwords in the output. Only the audited export
     * endpoint sets this; configuration review never does.
     */
    includeSecrets?: boolean;
    secretEncryptionKey?: Buffer;
    /** Compile for one node rather than fleet-wide. */
    nodeId?: string;
  } = {},
): Promise<CompileResult> {
  const { ir, issues } = await buildIr(db, registry, options.nodeId ? { nodeId: options.nodeId } : {});

  const { rows: users } = await db.query<{
    username: string;
    password_hash: string | null;
    status: 'ACTIVE' | 'DISABLED';
  }>('select username, password_hash, status from proxy_users order by username');

  const providerSecrets: Record<string, string> = {};
  if (options.includeSecrets && options.secretEncryptionKey) {
    const { rows: secretRows } = await db.query<{ key: string; ciphertext: string }>(
      `select p.key, s.ciphertext
       from provider_secrets s
       join auth_providers p on p.id = s.provider_id
       where s.name = 'bindPassword' and p.enabled and p.type = 'LDAP'`,
    );
    for (const row of secretRows) {
      providerSecrets[row.key] = decryptSecret(row.ciphertext, options.secretEncryptionKey);
    }
  }

  const compiled = compileConfiguration(ir, {
    adapter: getSquidAdapter(options.adapterId),
    localUsers: users.map((row) => ({
      username: row.username,
      passwordHash: row.password_hash ?? '',
      status: row.status,
    })),
    ...(options.includeSecrets ? { providerSecrets } : {}),
    ...(options.generatorVersion ? { generatorVersion: options.generatorVersion } : {}),
  });

  return { ...compiled, ir, issues };
}

/** Stores a compiled configuration so it can be reviewed and diffed later. */
export async function persistConfigVersion(
  db: Db,
  compiled: CompileResult,
  createdBy: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into config_versions (created_by, adapter_id, ir, squid_conf, warnings, findings)
     values ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)
     returning id`,
    [
      createdBy,
      compiled.adapterId,
      JSON.stringify(compiled.ir),
      compiled.squidConf,
      JSON.stringify(compiled.warnings),
      JSON.stringify(compiled.findings),
    ],
  );
  return rows[0]?.id ?? '';
}
