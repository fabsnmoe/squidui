/**
 * Squid configuration compiler.
 *
 * Deterministic: the same IR always produces byte identical output, which is
 * what makes the configuration review and the deployment diff meaningful.
 * The compiler performs no I/O - callers pass in everything it needs.
 */

import { detectSecurityFindings, type SecurityFinding } from '../policy/openProxy.js';
import {
  expandGroupRefs,
  sortRules,
  type ConfigurationIr,
  type IdentityGroupRef,
  type IrAuthenticationProvider,
  type LdapHelperSpec,
  type PolicyRule,
  type Weekday,
} from '../policy/ir.js';
import type { AuthenticationMode } from '../auth/model.js';
import { ACCESS_LOG_FORMAT, ACCESS_LOG_FORMAT_NAME } from './accessLog.js';
import { DEFAULT_SQUID_ADAPTER, type SquidVersionAdapter } from './adapter.js';

export interface LocalPasswordEntry {
  username: string;
  /** crypt(3) string, e.g. `$6$...`. Never a plaintext password. */
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface CompileOptions {
  adapter?: SquidVersionAdapter;
  /** Local proxy users, used to render the NCSA password file. */
  localUsers?: readonly LocalPasswordEntry[];
  /**
   * Bind passwords by provider key. The LDAP helpers read them from a file on
   * the node, so the file has to be produced - referencing it without shipping
   * it makes every directory authentication fail with a bind error.
   * Omitted for the review endpoint, which never handles secrets.
   */
  providerSecrets?: Readonly<Record<string, string>>;
  /** Emitted into the header for traceability. */
  generatorVersion?: string;
}

export interface CompilerWarning {
  code: string;
  message: string;
  ruleId?: string;
}

export interface ConfigArtefact {
  path: string;
  content: string;
  mode: string;
  /**
   * Ownership the file must have on the node. Squid drops privileges before
   * starting its helpers, so an artefact owned by root with mode 0640 is
   * unreadable for `basic_ncsa_auth` and every request ends in a 407. Mode
   * alone is not a sufficient contract.
   */
  owner: string;
  group: string;
  /** Contains password hashes or secrets - redact in the UI and in logs. */
  sensitive: boolean;
  description: string;
}

export interface CompiledConfiguration {
  squidConf: string;
  artefacts: ConfigArtefact[];
  warnings: CompilerWarning[];
  findings: SecurityFinding[];
  adapterId: string;
}

const DAY_LETTERS: Record<Weekday, string> = {
  SUN: 'S',
  MON: 'M',
  TUE: 'T',
  WED: 'W',
  THU: 'H',
  FRI: 'F',
  SAT: 'A',
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Squid ACL names must be stable, unique and free of whitespace. */
export function slug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base === '' ? 'x' : base;
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.trunc(minutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

class NameAllocator {
  private readonly used = new Set<string>();

  take(base: string): string {
    let candidate = base;
    let counter = 2;
    while (this.used.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    this.used.add(candidate);
    return candidate;
  }
}

/* -------------------------------------------------------------------------- */
/* Compiler                                                                    */
/* -------------------------------------------------------------------------- */

export function compileConfiguration(
  ir: ConfigurationIr,
  options: CompileOptions = {},
): CompiledConfiguration {
  const adapter = options.adapter ?? DEFAULT_SQUID_ADAPTER;
  const warnings: CompilerWarning[] = [];
  const artefacts: ConfigArtefact[] = [];
  const names = new NameAllocator();

  // Authentication is a per listener decision now (ADR 0003). The helper is
  // configured once, but which ports demand an identity is an ACL on the port
  // name - that is what makes a corporate and a guest listener coexist.
  const activeListeners = ir.listeners.filter((listener) => listener.enabled);
  const authEnabled = activeListeners.some((listener) => listener.authentication !== "DISABLED");
  // What the rule compiler should assume about identities, derived from the
  // listeners rather than from a global switch: no listener with auth means an
  // identity can never be known, every listener requiring it means one always
  // is, anything in between is the mixed case.
  const effectiveIdentityMode: AuthenticationMode = !authEnabled
    ? 'DISABLED'
    : activeListeners.every((listener) => listener.authentication === 'REQUIRED')
      ? 'REQUIRED'
      : 'OPTIONAL';

  const providers = [...ir.authentication.providers].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );

  const out: string[] = [];
  const section = (title: string): void => {
    out.push('');
    out.push(`# ${'-'.repeat(74)}`);
    out.push(`# ${title}`);
    out.push(`# ${'-'.repeat(74)}`);
  };

  /* --- header ----------------------------------------------------------- */
  out.push('# Generated by Squid Control Plane' + (options.generatorVersion ? ` ${options.generatorVersion}` : ''));
  out.push(`# Adapter:    ${adapter.displayName} (${adapter.id})`);
  out.push(`# IR version: ${ir.irVersion}`);
  out.push(`# Generated:  ${ir.generatedAt}`);
  out.push('#');
  out.push('# Do not edit on the node. Changes are overwritten on the next deployment.');

  /* --- baseline --------------------------------------------------------- */
  section('Baseline safety ACLs');
  out.push('acl SSL_ports port 443');
  out.push('acl Safe_ports port 80          # http');
  out.push('acl Safe_ports port 21          # ftp');
  out.push('acl Safe_ports port 443         # https');
  out.push('acl Safe_ports port 70          # gopher');
  out.push('acl Safe_ports port 210         # wais');
  out.push('acl Safe_ports port 1025-65535  # unregistered ports');
  out.push('acl Safe_ports port 280         # http-mgmt');
  out.push('acl Safe_ports port 488         # gss-http');
  out.push('acl Safe_ports port 591         # filemaker');
  out.push('acl Safe_ports port 777         # multiling http');
  out.push('acl CONNECT method CONNECT');
  out.push('');
  out.push('http_access deny !Safe_ports');
  out.push('http_access deny CONNECT !SSL_ports');
  out.push('http_access allow localhost manager');
  out.push('http_access deny manager');

  /* --- authentication --------------------------------------------------- */
  section(`Proxy authentication - ${activeListeners.filter((l) => l.authentication !== 'DISABLED').length} of ${activeListeners.length} listeners require an identity`);
  if (!authEnabled) {
    out.push('# Authentication is disabled: Squid never requests proxy credentials.');
    if (providers.length > 0) {
      warnings.push({
        code: 'PROVIDERS_IGNORED',
        message:
          'Authentication mode is DISABLED, so the enabled providers are not written to the configuration.',
      });
    }
  } else if (providers.length === 0) {
    out.push('# WARNING: no provider enabled - no client can authenticate.');
    warnings.push({
      code: 'NO_PROVIDER',
      message: `Authentication mode is ${ir.authentication.mode} but no provider is enabled.`,
    });
  } else {
    const authProgram = buildAuthProgram(providers, adapter, warnings);
    out.push(`auth_param basic program ${authProgram}`);
    out.push('auth_param basic children 20 startup=0 idle=1 concurrency=0');
    out.push(`auth_param basic realm ${ir.authentication.realm}`);
    out.push('auth_param basic credentialsttl 2 hours');
    out.push('auth_param basic casesensitive off');
    out.push('');
    out.push('acl scp_authenticated proxy_auth REQUIRED');
  }

  /* --- source networks -------------------------------------------------- */
  const networkAclByRule = new Map<string, string[]>();
  const emittedNetworks = new Map<string, string>();
  const networkLines: string[] = [];
  for (const rule of sortRules(ir.rules)) {
    if (rule.source.kind === 'ANY') continue;
    const aclNames: string[] = [];
    for (const network of rule.source.networks) {
      const cidrs = network.cidrs.filter((cidr) => cidr.trim() !== '');
      if (cidrs.length === 0) {
        warnings.push({
          code: 'EMPTY_NETWORK',
          ruleId: rule.id,
          message: `Network "${network.name}" has no CIDR entries and matches nothing.`,
        });
        continue;
      }
      let aclName = emittedNetworks.get(network.id);
      if (!aclName) {
        aclName = names.take(`scp_net_${slug(network.name)}`);
        emittedNetworks.set(network.id, aclName);
        networkLines.push(`acl ${aclName} src ${cidrs.join(' ')}`);
      }
      aclNames.push(aclName);
    }
    networkAclByRule.set(rule.id, aclNames);
  }
  if (networkLines.length > 0) {
    section('Source networks');
    out.push(...networkLines);
  }

  /* --- identity groups -------------------------------------------------- */
  const groupAcl = new Map<string, string>(); // group key -> acl name
  const groupLines: string[] = [];
  const externalAclTypes = new Set<string>();
  if (authEnabled) {
    for (const rule of sortRules(ir.rules)) {
      if (rule.identity.kind !== 'GROUP') continue;
      for (const ref of expandGroupRefs(rule.identity.groups)) {
        const key = `${ref.source}:${ref.providerKey ?? ''}:${ref.name}`;
        if (groupAcl.has(key)) continue;

        if (ref.source === 'LOCAL') {
          const members = (ir.authentication.localGroupMembers[ref.name] ?? []).filter(Boolean);
          if (members.length === 0) {
            warnings.push({
              code: 'EMPTY_GROUP',
              ruleId: rule.id,
              message: `Local group "${ref.name}" has no active members, so rules referencing it never match.`,
            });
            groupAcl.set(key, '');
            continue;
          }
          const aclName = names.take(`scp_grp_local_${slug(ref.name)}`);
          groupAcl.set(key, aclName);
          groupLines.push(`acl ${aclName} proxy_auth ${members.join(' ')}`);
        } else {
          const provider = providers.find((candidate) => candidate.key === ref.providerKey);
          if (!provider || provider.helper.kind !== 'LDAP') {
            warnings.push({
              code: 'UNKNOWN_EXTERNAL_GROUP_PROVIDER',
              ruleId: rule.id,
              message: `Group "${ref.name}" refers to provider "${ref.providerKey ?? '?'}", which is not an enabled LDAP provider.`,
            });
            groupAcl.set(key, '');
            continue;
          }
          const typeName = `scp_ldapgrp_${slug(provider.key)}`;
          if (!externalAclTypes.has(typeName)) {
            externalAclTypes.add(typeName);
            groupLines.push(buildExternalAclType(typeName, provider.helper, adapter));
          }
          const aclName = names.take(`scp_grp_${slug(provider.key)}_${slug(ref.name)}`);
          groupAcl.set(key, aclName);
          groupLines.push(`acl ${aclName} external ${typeName} ${quote(ref.name)}`);
        }
      }
    }
  }
  if (groupLines.length > 0) {
    section('Identity groups');
    out.push(...groupLines);
  }

  /* --- users ------------------------------------------------------------ */
  const userAclByRule = new Map<string, string>();
  const userLines: string[] = [];
  if (authEnabled) {
    for (const rule of sortRules(ir.rules)) {
      if (rule.identity.kind !== 'USER') continue;
      const usernames = rule.identity.users.map((ref) => ref.username).filter(Boolean);
      if (usernames.length === 0) {
        warnings.push({
          code: 'EMPTY_USER_LIST',
          ruleId: rule.id,
          message: `Rule ${rule.position} "${rule.name}" has an empty user list and never matches.`,
        });
        continue;
      }
      const aclName = names.take(`scp_user_r${rule.position}`);
      userAclByRule.set(rule.id, aclName);
      userLines.push(`acl ${aclName} proxy_auth ${usernames.join(' ')}`);
    }
  }
  if (userLines.length > 0) {
    section('Named users');
    out.push(...userLines);
  }

  /* --- destinations and schedules --------------------------------------- */
  const destinationAclByRule = new Map<string, string[]>();
  const scheduleAclByRule = new Map<string, string>();
  const destinationLines: string[] = [];
  const scheduleLines: string[] = [];
  for (const rule of sortRules(ir.rules)) {
    const acls: string[] = [];
    const destination = rule.destination;
    if (destination.kind === 'SPECIFIC') {
      const domains = (destination.domains ?? []).filter((entry) => entry.trim() !== '');
      const cidrs = (destination.cidrs ?? []).filter((entry) => entry.trim() !== '');
      const ports = destination.ports ?? [];
      if (domains.length > 0) {
        const aclName = names.take(`scp_dst_r${rule.position}_dom`);
        destinationLines.push(`acl ${aclName} dstdomain ${domains.join(' ')}`);
        acls.push(aclName);
      }
      if (cidrs.length > 0) {
        const aclName = names.take(`scp_dst_r${rule.position}_net`);
        destinationLines.push(`acl ${aclName} dst ${cidrs.join(' ')}`);
        acls.push(aclName);
      }
      if (ports.length > 0) {
        const aclName = names.take(`scp_dst_r${rule.position}_port`);
        destinationLines.push(`acl ${aclName} port ${ports.join(' ')}`);
        acls.push(aclName);
      }
      if (domains.length > 0 && cidrs.length > 0) {
        // Squid ANDs ACLs on one http_access line; the engine ORs domain and
        // network destinations. Emitting both would silently narrow the rule.
        warnings.push({
          code: 'DESTINATION_DOMAIN_AND_NETWORK',
          ruleId: rule.id,
          message:
            `Rule ${rule.position} "${rule.name}" combines destination domains and destination networks. ` +
            'Squid evaluates them as AND on a single access line, while the policy engine treats them as OR. ' +
            'Split the rule to keep both consistent.',
        });
      }
      if (acls.length === 0) {
        warnings.push({
          code: 'EMPTY_DESTINATION',
          ruleId: rule.id,
          message: `Rule ${rule.position} "${rule.name}" has a specific destination without any entry; it is treated as "any".`,
        });
      }
    }
    destinationAclByRule.set(rule.id, acls);

    if (rule.schedule.kind === 'WINDOW') {
      const days = rule.schedule.days.map((day) => DAY_LETTERS[day]).join('');
      const aclName = names.take(`scp_time_r${rule.position}`);
      scheduleLines.push(
        `acl ${aclName} time ${days} ${formatMinutes(rule.schedule.startMinutes)}-${formatMinutes(rule.schedule.endMinutes)}`,
      );
      scheduleAclByRule.set(rule.id, aclName);
    }
  }
  if (destinationLines.length > 0) {
    section('Destinations');
    out.push(...destinationLines);
  }
  if (scheduleLines.length > 0) {
    section('Schedules');
    out.push(...scheduleLines);
  }

  /* --- listeners -------------------------------------------------------- */
  // Emitted before the access rules because the rules reference the port ACLs.
  section('Listeners');
  if (activeListeners.length === 0) {
    out.push('# No listener configured.');
    warnings.push({ code: 'NO_LISTENER', message: 'No listener is configured; Squid will not accept traffic.' });
  }

  const listenerAcl = new Map<string, string>();
  const listenerGuards: string[] = [];

  for (const listener of ir.listeners) {
    if (!listener.enabled) {
      out.push(`# Listener "${listener.name}" is disabled.`);
      continue;
    }

    const bind =
      listener.address.includes(':') && !listener.address.startsWith('[')
        ? `[${listener.address}]:${listener.port}`
        : `${listener.address}:${listener.port}`;
    const portName = slug(listener.key || listener.name);
    const aclName = names.take(`scp_lp_${portName}`);
    listenerAcl.set(listener.id, aclName);

    out.push(
      `http_port ${bind} name=${portName}${listener.mode === 'INTERCEPT' ? ' intercept' : ''}` +
        `  # ${listener.name} (${listener.authentication.toLowerCase()})`,
    );
    // myportname, not the port number: two listeners may share a port on
    // different addresses, and the name is what the profile owns.
    out.push(`acl ${aclName} myportname ${portName}`);

    const cidrs = listener.sourceNetworks.flatMap((network) => network.cidrs).filter(Boolean);
    if (cidrs.length > 0) {
      const srcAcl = names.take(`scp_lpsrc_${portName}`);
      out.push(`acl ${srcAcl} src ${cidrs.join(' ')}`);
      listenerGuards.push(
        `http_access deny ${aclName} !${srcAcl}  # ${listener.name}: only its own source networks`,
      );
    }

    if (listener.authentication === 'REQUIRED') {
      // Scoped to this listener, so a guest port next to it is never
      // challenged - which is the whole point of moving auth onto the listener.
      listenerGuards.push(
        `http_access deny ${aclName} !scp_authenticated  # ${listener.name}: credentials required`,
      );
    }
  }

  /* --- access rules ----------------------------------------------------- */
  section('Access rules');
  if (listenerGuards.length > 0) {
    out.push('# Listener guards. Evaluated before any rule, so a listener that requires');
    out.push('# credentials challenges only its own clients and a guest listener next to');
    out.push('# it is never asked for any.');
    for (const guard of listenerGuards) out.push(guard);
    out.push('');
  }

  let sawAuthenticatedRule = false;
  const rules = sortRules(ir.rules);
  for (const rule of rules) {
    if (!rule.enabled) {
      out.push(`# Rule ${rule.position} "${rule.name}" is disabled.`);
      continue;
    }

    const identityTerms = buildIdentityTerms(
      rule,
      groupAcl,
      userAclByRule,
      effectiveIdentityMode,
      warnings,
    );
    if (identityTerms === null) {
      out.push(`# Rule ${rule.position} "${rule.name}" omitted: identity condition can never match.`);
      continue;
    }

    if (
      effectiveIdentityMode === 'OPTIONAL' &&
      rule.identity.kind === 'UNAUTHENTICATED' &&
      sawAuthenticatedRule
    ) {
      warnings.push({
        code: 'OPTIONAL_MODE_RULE_ORDER',
        ruleId: rule.id,
        message:
          `Rule ${rule.position} "${rule.name}" matches unauthenticated clients but is placed after a rule that ` +
          'requires authentication. Squid challenges the client as soon as it evaluates the earlier rule, so ' +
          'anonymous clients see a credentials prompt. Move unauthenticated rules above authenticated ones.',
      });
    }
    if (
      rule.identity.kind === 'AUTHENTICATED' ||
      rule.identity.kind === 'USER' ||
      rule.identity.kind === 'GROUP'
    ) {
      sawAuthenticatedRule = true;
    }

    const sourceTerms = networkAclByRule.get(rule.id) ?? [];
    const scheduleAcl = scheduleAclByRule.get(rule.id);
    const restTerms = [
      ...(destinationAclByRule.get(rule.id) ?? []),
      ...(scheduleAcl ? [scheduleAcl] : []),
    ];

    out.push(`# Rule ${rule.position} - ${rule.name}`);
    for (const line of buildAccessLines(rule, sourceTerms, identityTerms, restTerms)) out.push(line);
  }

  out.push('');
  out.push(`# Default access policy`);
  out.push(ir.defaultAccess === 'ALLOW' ? 'http_access allow all' : 'http_access deny all');

  section('Operational defaults');
  out.push('coredump_dir /var/spool/squid');
  out.push('');
  out.push('# Structured access log. The node agent ships these lines to the control');
  out.push('# plane, which parses them, so the format is defined in exactly one place.');
  out.push(`logformat ${ACCESS_LOG_FORMAT_NAME} ${ACCESS_LOG_FORMAT}`);
  out.push(`access_log ${adapter.paths.accessLog} ${ACCESS_LOG_FORMAT_NAME}`);
  out.push('refresh_pattern ^ftp:           1440  20%  10080');
  out.push('refresh_pattern ^gopher:        1440   0%   1440');
  out.push('refresh_pattern -i (/cgi-bin/|\\?) 0    0%      0');
  out.push('refresh_pattern .                  0  20%   4320');
  out.push('');

  /* --- artefacts -------------------------------------------------------- */
  const localProvider = providers.find((provider) => provider.helper.kind === 'NCSA');
  if (authEnabled && localProvider && localProvider.helper.kind === 'NCSA') {
    artefacts.push(
      buildNcsaArtefact(localProvider.helper.passwordFile, options.localUsers ?? [], warnings, adapter),
    );
  }
  if (authEnabled && providers.length > 1) {
    artefacts.push(buildMultiAuthArtefact(providers, adapter));
  }
  if (authEnabled) {
    for (const provider of providers) {
      if (provider.helper.kind !== 'LDAP' || !provider.helper.bindPasswordRef) continue;
      const secret = options.providerSecrets?.[provider.key];
      if (secret === undefined) {
        warnings.push({
          code: 'BIND_SECRET_NOT_AVAILABLE',
          message:
            `The bind password file for provider "${provider.name}" is not part of this output. ` +
            'Configuration review never handles secrets; deploy through the export endpoint.',
        });
        continue;
      }
      artefacts.push({
        path: `${adapter.paths.secretsDir}/${provider.helper.bindPasswordRef}`,
        // basic_ldap_auth reads the first line of the file as the password.
        content: `${secret}\n`,
        mode: '0640',
        owner: adapter.runtimeUser,
        group: adapter.runtimeGroup,
        sensitive: true,
        description: `Bind password for ${provider.name}, read by the LDAP helpers via -W.`,
      });
    }
  }

  return {
    squidConf: `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`,
    artefacts,
    warnings,
    findings: detectSecurityFindings(ir),
    adapterId: adapter.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Fragments                                                                   */
/* -------------------------------------------------------------------------- */

function buildIdentityTerms(
  rule: PolicyRule,
  groupAcl: Map<string, string>,
  userAclByRule: Map<string, string>,
  mode: AuthenticationMode,
  warnings: CompilerWarning[],
): string[] | null {
  const matcher = rule.identity;
  if (matcher.kind === 'ANY') return [];

  if (mode === 'DISABLED') {
    // With authentication off, only UNAUTHENTICATED can still be satisfied and
    // it is satisfied by everyone, so it degenerates to "no condition".
    if (matcher.kind === 'UNAUTHENTICATED') return [];
    warnings.push({
      code: 'IDENTITY_RULE_WITHOUT_AUTH',
      ruleId: rule.id,
      message: `Rule ${rule.position} "${rule.name}" requires an identity but authentication is disabled; the rule is omitted.`,
    });
    return null;
  }

  switch (matcher.kind) {
    case 'AUTHENTICATED':
      return ['scp_authenticated'];

    case 'UNAUTHENTICATED': {
      if (mode === 'REQUIRED') {
        warnings.push({
          code: 'UNAUTHENTICATED_RULE_IN_REQUIRED_MODE',
          ruleId: rule.id,
          message:
            `Rule ${rule.position} "${rule.name}" matches unauthenticated clients, but the mode is REQUIRED, ` +
            'so every client is challenged before rules run. The rule is omitted.',
        });
        return null;
      }
      /*
       * Squid asks for credentials as soon as it evaluates *any* ACL backed by
       * proxy_auth - including a negated one. Compiling this as
       * `!scp_authenticated` therefore challenges exactly the anonymous clients
       * the rule is meant to let through, which defeats OPTIONAL mode entirely.
       *
       * The working idiom is to drop the identity condition and rely on the
       * remaining conditions (source, destination, schedule). The rule then also
       * matches authenticated clients that meet those conditions, which is a
       * widening - so it is reported rather than applied silently.
       */
      warnings.push({
        code: 'UNAUTHENTICATED_WIDENED',
        ruleId: rule.id,
        message:
          `Rule ${rule.position} "${rule.name}" matches unauthenticated clients. Squid challenges a client as soon ` +
          'as it evaluates any condition backed by proxy_auth, so the identity condition is omitted and the rule ' +
          'is decided by its source, destination and schedule alone. Authenticated clients meeting the same ' +
          'conditions therefore match it too. Use a dedicated listener for anonymous clients if the distinction ' +
          'must be enforced: give anonymous clients their own listener profile with authentication disabled.',
      });
      return [];
    }
    case 'USER': {
      const aclName = userAclByRule.get(rule.id);
      return aclName ? [aclName] : null;
    }
    case 'GROUP': {
      // Multiple groups are an OR, which Squid expresses as one access line
      // per group. `buildAccessLines` fans them out.
      const acls = expandGroupRefs(matcher.groups)
        .map((ref) => groupAcl.get(`${ref.source}:${ref.providerKey ?? ''}:${ref.name}`))
        .filter((name): name is string => Boolean(name));
      return acls.length > 0 ? acls : null;
    }
  }
}

/**
 * Squid ANDs the ACLs on a single `http_access` line. A GROUP matcher with
 * several groups is an OR, so it becomes one line per group.
 */
function buildAccessLines(
  rule: PolicyRule,
  sourceTerms: readonly string[],
  identityTerms: readonly string[],
  restTerms: readonly string[],
): string[] {
  const verb = rule.action === 'ALLOW' ? 'allow' : 'deny';
  const emit = (identity: readonly string[]): string => {
    const terms = dedupe([...sourceTerms, ...identity, ...restTerms]);
    return `http_access ${verb} ${terms.length > 0 ? terms.join(' ') : 'all'}`;
  };
  if (rule.identity.kind === 'GROUP' && identityTerms.length > 1) {
    return identityTerms.map((term) => emit([term]));
  }
  return [emit(identityTerms)];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function buildAuthProgram(
  providers: readonly IrAuthenticationProvider[],
  adapter: SquidVersionAdapter,
  warnings: CompilerWarning[],
): string {
  const first = providers[0];
  if (!first) return '';

  if (providers.length === 1) {
    return first.helper.kind === 'NCSA'
      ? `${adapter.helpers.ncsaAuth} ${first.helper.passwordFile}`
      : buildLdapAuthCommand(first.helper, adapter);
  }

  // Squid accepts exactly one basic auth helper. Running several providers in
  // parallel therefore needs a multiplexer, which the control plane generates
  // and ships as an artefact (PRODUCT.md section 10).
  warnings.push({
    code: 'MULTI_PROVIDER_HELPER',
    message:
      `${providers.length} providers are enabled. Squid supports one basic auth helper, so the generated ` +
      `multiplexer ${adapter.helpers.multiProviderAuth} is deployed and queries the providers in priority order.`,
  });
  return `${adapter.helpers.multiProviderAuth}`;
}

function buildLdapAuthCommand(helper: LdapHelperSpec, adapter: SquidVersionAdapter): string {
  const parts = [adapter.helpers.ldapAuth, '-v', '3'];
  parts.push('-b', quote(helper.baseDn));
  parts.push('-f', quote(helper.userFilter));
  if (helper.bindDn) parts.push('-D', quote(helper.bindDn));
  if (helper.bindPasswordRef) {
    parts.push('-W', quote(`${adapter.paths.secretsDir}/${helper.bindPasswordRef}`));
  }
  if (helper.useTls) parts.push('-ZZ');
  parts.push('-H', quote(helper.uri));
  return parts.join(' ');
}

function buildExternalAclType(
  typeName: string,
  helper: LdapHelperSpec,
  adapter: SquidVersionAdapter,
): string {
  const parts = [
    `external_acl_type ${typeName} ttl=300 negative_ttl=60 %LOGIN`,
    adapter.helpers.ldapGroupAcl,
    '-v',
    '3',
    '-b',
    quote(helper.groupBaseDn ?? helper.baseDn),
    '-f',
    quote(helper.groupFilter ?? '(&(objectClass=group)(member=%u)(cn=%g))'),
  ];
  if (helper.bindDn) parts.push('-D', quote(helper.bindDn));
  if (helper.bindPasswordRef) {
    parts.push('-W', quote(`${adapter.paths.secretsDir}/${helper.bindPasswordRef}`));
  }
  if (helper.useTls) parts.push('-ZZ');
  parts.push('-h', quote(helper.uri));
  return parts.join(' ');
}

function buildNcsaArtefact(
  path: string,
  users: readonly LocalPasswordEntry[],
  warnings: CompilerWarning[],
  adapter: SquidVersionAdapter,
): ConfigArtefact {
  const lines: string[] = [];
  for (const user of [...users].sort((a, b) => a.username.localeCompare(b.username))) {
    if (user.status !== 'ACTIVE') continue;
    if (!user.passwordHash) {
      warnings.push({
        code: 'USER_WITHOUT_PASSWORD',
        message: `Local proxy user "${user.username}" has no password set and cannot authenticate.`,
      });
      continue;
    }
    if (user.username.includes(':') || /\s/.test(user.username)) {
      warnings.push({
        code: 'INVALID_USERNAME',
        message: `Local proxy user "${user.username}" contains characters the NCSA file format cannot represent; it is skipped.`,
      });
      continue;
    }
    lines.push(`${user.username}:${user.passwordHash}`);
  }
  return {
    path,
    content: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    // Readable by the group Squid's helpers run under, writable only by root.
    mode: '0640',
    owner: adapter.runtimeUser,
    group: adapter.runtimeGroup,
    sensitive: true,
    description: 'Local proxy users in NCSA/htpasswd format, consumed by basic_ncsa_auth.',
  };
}

function buildMultiAuthArtefact(
  providers: readonly IrAuthenticationProvider[],
  adapter: SquidVersionAdapter,
): ConfigArtefact {
  const backends = providers.map((provider) =>
    provider.helper.kind === 'NCSA'
      ? `${adapter.helpers.ncsaAuth} ${provider.helper.passwordFile}`
      : buildLdapAuthCommand(provider.helper, adapter),
  );

  const content = `#!/usr/bin/perl -w
#
# Generated by Squid Control Plane. Do not edit on the node.
#
# Squid supports a single basic authentication helper. This multiplexer keeps
# the configured providers running as co-processes and asks them in priority
# order until one answers OK, which is what makes "Local + LDAP in parallel"
# work (PRODUCT.md section 10). A provider that dies or times out is skipped,
# so an LDAP outage never disables local accounts (PRODUCT.md section 20).

use strict;
use IPC::Open2;

my @backends = (
${backends.map((command) => `  ${JSON.stringify(command)},`).join('\n')}
);

my @procs;
for my $command (@backends) {
  my ($reader, $writer);
  my $pid = eval { open2($reader, $writer, $command) };
  if ($@ || !$pid) {
    push @procs, undef;
    next;
  }
  $writer->autoflush(1);
  push @procs, { pid => $pid, in => $reader, out => $writer };
}

$| = 1;
while (my $line = <STDIN>) {
  chomp $line;
  my $answer = "ERR message=no_provider_available";
  for my $proc (@procs) {
    next unless defined $proc;
    my $reply = eval {
      local $SIG{ALRM} = sub { die "timeout\\n" };
      alarm(10);
      my $out = $proc->{out};
      my $in = $proc->{in};
      print $out "$line\\n";
      my $response = <$in>;
      alarm(0);
      $response;
    };
    alarm(0);
    if ($@ || !defined $reply) {
      $proc = undef;
      next;
    }
    chomp $reply;
    if ($reply =~ /^OK/) { $answer = $reply; last; }
    $answer = $reply;
  }
  print "$answer\\n";
}
`;

  return {
    path: adapter.helpers.multiProviderAuth,
    content,
    mode: '0750',
    owner: adapter.runtimeUser,
    group: adapter.runtimeGroup,
    sensitive: false,
    description:
      'Basic auth multiplexer that queries the enabled providers in priority order. Required when more than one provider is enabled.',
  };
}
