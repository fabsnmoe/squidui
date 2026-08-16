import { Client } from 'ldapts';
import type { IdentityGroupRef, IrAuthenticationProvider, ProviderCapabilities } from '@scp/shared';
import {
  disabledHealth,
  healthy,
  unreachable,
  type AuthenticationAttempt,
  type AuthenticationOutcome,
  type AuthenticationProviderAdapter,
  type ProviderStatistics,
  type ProviderTestCheck,
  type ProviderTestResult,
} from './types.js';

/**
 * LDAP provider (PLAN.md 9.7).
 *
 * Authentication is a search-then-bind: bind as the service account, find the
 * user's DN, then bind as that DN with the supplied password. That is the only
 * way to verify a password without ever sending it anywhere but the directory.
 */

export interface LdapProviderConfig {
  uri: string;
  baseDn: string;
  userFilter: string;
  bindDn: string | null;
  useTls: boolean;
  startTls: boolean;
  tlsRejectUnauthorized: boolean;
  groupBaseDn: string | null;
  groupFilter: string | null;
  displayNameAttribute: string;
  connectTimeoutMs: number;
}

export const LDAP_DEFAULTS: LdapProviderConfig = {
  uri: 'ldap://ldap.example.internal:389',
  baseDn: '',
  userFilter: '(uid=%s)',
  bindDn: null,
  useTls: false,
  startTls: false,
  tlsRejectUnauthorized: true,
  groupBaseDn: null,
  groupFilter: '(&(objectClass=groupOfNames)(member=%u))',
  displayNameAttribute: 'displayName',
  connectTimeoutMs: 5000,
};

export function parseLdapConfig(raw: unknown): LdapProviderConfig {
  const value = (raw ?? {}) as Partial<LdapProviderConfig>;
  return {
    ...LDAP_DEFAULTS,
    ...value,
    uri: value.uri ?? LDAP_DEFAULTS.uri,
    baseDn: value.baseDn ?? LDAP_DEFAULTS.baseDn,
    userFilter: value.userFilter ?? LDAP_DEFAULTS.userFilter,
  };
}

/** RFC 4515 filter escaping. Without this a username can rewrite the filter. */
export function escapeLdapFilterValue(value: string): string {
  let out = '';
  for (const char of value) {
    switch (char) {
      case '*':
        out += '\\2a';
        break;
      case '(':
        out += '\\28';
        break;
      case ')':
        out += '\\29';
        break;
      case '\\':
        out += '\\5c';
        break;
      case '\0':
        out += '\\00';
        break;
      case '/':
        out += '\\2f';
        break;
      default:
        out += char;
    }
  }
  return out;
}

export function renderFilter(template: string, replacements: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(escapeLdapFilterValue(value));
  }
  return out;
}

export interface LdapProviderRow {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  priority: number;
  config: unknown;
}

export class LdapAuthenticationProvider implements AuthenticationProviderAdapter {
  readonly type = 'LDAP' as const;
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly config: LdapProviderConfig;

  constructor(
    row: LdapProviderRow,
    /** Resolved lazily so the secret is only decrypted when actually needed. */
    private readonly resolveBindPassword: () => Promise<string | null>,
    private readonly secretsDir: string,
  ) {
    this.id = row.id;
    this.key = row.key;
    this.name = row.name;
    this.enabled = row.enabled;
    this.priority = row.priority;
    this.config = parseLdapConfig(row.config);
  }

  capabilities(): ProviderCapabilities {
    return {
      authenticate: true,
      userLookup: true,
      groupLookup: Boolean(this.config.groupBaseDn),
      passwordManagement: false,
      connectionTest: true,
    };
  }

  /** True when the transport is encrypted from the first byte or upgraded later. */
  private usesTls(): boolean {
    return this.config.uri.startsWith('ldaps://') || this.config.startTls;
  }

  private createClient(): Client {
    // `tlsOptions` must only be present when TLS is actually used: passing it
    // for a plain ldap:// URL makes the client attempt a TLS handshake against
    // a cleartext port, which fails with "socket disconnected before secure
    // TLS connection was established".
    return new Client({
      url: this.config.uri,
      timeout: this.config.connectTimeoutMs,
      connectTimeout: this.config.connectTimeoutMs,
      ...(this.usesTls() ? { tlsOptions: { rejectUnauthorized: this.config.tlsRejectUnauthorized } } : {}),
    });
  }

  private async bindService(client: Client): Promise<void> {
    if (this.config.startTls) {
      await client.startTLS({ rejectUnauthorized: this.config.tlsRejectUnauthorized });
    }
    const bindDn = this.config.bindDn;
    if (!bindDn) return; // anonymous bind
    const password = await this.resolveBindPassword();
    await client.bind(bindDn, password ?? '');
  }

  async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationOutcome> {
    if (attempt.password === '') {
      // An empty password would be an unauthenticated bind, which LDAP happily
      // accepts and which would turn into a false positive.
      return { outcome: 'REJECTED', message: 'Empty passwords are rejected.' };
    }

    const client = this.createClient();
    let userClient: Client | null = null;
    try {
      await this.bindService(client);

      const filter = renderFilter(this.config.userFilter, { '%s': attempt.username, '%u': attempt.username });
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        sizeLimit: 2,
        attributes: ['dn', this.config.displayNameAttribute],
      });

      const entry = searchEntries[0];
      if (!entry || searchEntries.length > 1) {
        return { outcome: 'REJECTED', message: 'Unknown user or invalid credentials.' };
      }

      userClient = this.createClient();
      if (this.config.startTls) {
        await userClient.startTLS({ rejectUnauthorized: this.config.tlsRejectUnauthorized });
      }
      try {
        await userClient.bind(entry.dn, attempt.password);
      } catch {
        return { outcome: 'REJECTED', message: 'Unknown user or invalid credentials.' };
      }

      const groups = await this.groupsOf(client, entry.dn, attempt.username);
      const displayNameRaw = entry[this.config.displayNameAttribute];
      return {
        outcome: 'SUCCESS',
        username: attempt.username,
        displayName: typeof displayNameRaw === 'string' ? displayNameRaw : null,
        groups,
      };
    } catch (error) {
      // A directory that is down must not look like a wrong password: the
      // registry needs to distinguish "rejected" from "unavailable" so local
      // accounts keep working (PRODUCT.md section 20).
      return {
        outcome: 'UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.unbind().catch(() => undefined);
      await userClient?.unbind().catch(() => undefined);
    }
  }

  private async groupsOf(client: Client, userDn: string, username: string): Promise<IdentityGroupRef[]> {
    const base = this.config.groupBaseDn;
    const template = this.config.groupFilter;
    if (!base || !template) return [];
    try {
      const filter = renderFilter(template, { '%u': userDn, '%s': username, '%g': '*' })
        // A group filter may contain a %g placeholder for external_acl usage;
        // for a plain membership lookup it becomes a wildcard.
        .replace(/\\2a/g, '*');
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter,
        attributes: ['cn'],
        sizeLimit: 500,
      });
      return searchEntries
        .map((entry) => (typeof entry.cn === 'string' ? entry.cn : Array.isArray(entry.cn) ? String(entry.cn[0]) : null))
        .filter((name): name is string => Boolean(name))
        .map((name) => ({ source: 'EXTERNAL' as const, name, providerKey: this.key }));
    } catch {
      // Group lookup failure must not fail the authentication itself.
      return [];
    }
  }

  async statistics(): Promise<ProviderStatistics> {
    return { users: null, groups: null };
  }

  async testConnection(): Promise<ProviderTestResult> {
    const checks: ProviderTestCheck[] = [];
    const client = this.createClient();
    try {
      if (this.config.startTls) {
        await client.startTLS({ rejectUnauthorized: this.config.tlsRejectUnauthorized });
        checks.push({ label: 'TLS established', ok: true });
      } else {
        checks.push({
          label: this.config.uri.startsWith('ldaps://') ? 'TLS established' : 'Plain connection (no TLS)',
          ok: true,
        });
      }
      checks.push({ label: 'Server reachable', ok: true, detail: this.config.uri });

      await this.bindService(client);
      checks.push({
        label: 'Bind successful',
        ok: true,
        detail: this.config.bindDn ?? 'anonymous bind',
      });

      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        sizeLimit: 1,
        attributes: ['dn'],
      });
      checks.push({
        label: 'Search base accessible',
        ok: searchEntries.length > 0,
        detail: this.config.baseDn,
      });

      const ok = checks.every((check) => check.ok);
      return { ok, summary: ok ? 'LDAP provider reachable.' : 'LDAP reachable, but the search base is not.', checks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ label: 'Connection', ok: false, detail: message });
      return { ok: false, summary: `LDAP provider unreachable: ${message}`, checks };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async health() {
    if (!this.enabled) return disabledHealth();
    const started = Date.now();
    const result = await this.testConnection();
    return result.ok
      ? healthy('Directory reachable and bind successful.', Date.now() - started)
      : unreachable(result.summary);
  }

  toIr(): IrAuthenticationProvider {
    return {
      key: this.key,
      type: 'LDAP',
      name: this.name,
      priority: this.priority,
      helper: {
        kind: 'LDAP',
        uri: this.config.uri,
        baseDn: this.config.baseDn,
        userFilter: this.config.userFilter,
        bindDn: this.config.bindDn,
        // Only a reference: the value stays in the control plane (T5).
        bindPasswordRef: this.config.bindDn ? `${this.key}.secret` : null,
        useTls: this.config.useTls || this.config.startTls || this.config.uri.startsWith('ldaps://'),
        groupBaseDn: this.config.groupBaseDn,
        groupFilter: this.config.groupFilter,
        children: 20,
      },
    };
  }

  /** Path the helper reads the bind password from on the proxy node. */
  secretPath(): string {
    return `${this.secretsDir}/${this.key}.secret`;
  }
}
