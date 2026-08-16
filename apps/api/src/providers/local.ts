import type { IdentityGroupRef, IrAuthenticationProvider, ProviderCapabilities } from '@scp/shared';
import { verifyProxyPassword } from '@scp/shared/crypt';
import type { Db } from '../db/pool.js';
import {
  disabledHealth,
  healthy,
  unreachable,
  type AuthenticationAttempt,
  type AuthenticationOutcome,
  type AuthenticationProviderAdapter,
  type ProviderStatistics,
  type ProviderTestResult,
} from './types.js';

/**
 * Local proxy users (PLAN.md 9.4, 9.6).
 *
 * The provider that must keep working when everything else is down: an LDAP
 * outage may never invalidate emergency and service accounts
 * (PRODUCT.md section 20).
 */

export interface LocalProviderRow {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  priority: number;
}

export class LocalAuthenticationProvider implements AuthenticationProviderAdapter {
  readonly type = 'LOCAL' as const;
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;

  constructor(
    private readonly db: Db,
    row: LocalProviderRow,
    private readonly passwordFile: string,
  ) {
    this.id = row.id;
    this.key = row.key;
    this.name = row.name;
    this.enabled = row.enabled;
    this.priority = row.priority;
  }

  capabilities(): ProviderCapabilities {
    return {
      authenticate: true,
      userLookup: true,
      groupLookup: true,
      passwordManagement: true,
      connectionTest: true,
    };
  }

  async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationOutcome> {
    let row;
    try {
      const { rows } = await this.db.query<{
        id: string;
        username: string;
        display_name: string | null;
        status: string;
        password_hash: string | null;
      }>(
        `select id, username, display_name, status, password_hash
         from proxy_users
         where lower(username) = lower($1)`,
        [attempt.username],
      );
      row = rows[0];
    } catch (error) {
      return {
        outcome: 'UNAVAILABLE',
        message: `Local user store unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Same generic answer for "no such user", "disabled" and "wrong password":
    // the caller must not be able to enumerate accounts.
    const rejected: AuthenticationOutcome = {
      outcome: 'REJECTED',
      message: 'Unknown user or invalid credentials.',
    };

    if (!row || !row.password_hash || row.status !== 'ACTIVE') {
      // Still spend the verification cost so timing does not reveal existence.
      verifyProxyPassword(attempt.password, '$6$decoy$decoyhashvalueusedonlyfortimingpurposes');
      return rejected;
    }
    if (!verifyProxyPassword(attempt.password, row.password_hash)) return rejected;

    const groups = await this.groupsOf(row.id);
    return {
      outcome: 'SUCCESS',
      username: row.username,
      displayName: row.display_name,
      groups,
    };
  }

  private async groupsOf(userId: string): Promise<IdentityGroupRef[]> {
    const { rows } = await this.db.query<{ name: string }>(
      `select g.name
       from proxy_user_groups ug
       join proxy_groups g on g.id = ug.group_id
       where ug.user_id = $1 and g.source = 'LOCAL'
       order by g.name`,
      [userId],
    );
    return rows.map((row) => ({ source: 'LOCAL' as const, name: row.name, providerKey: null }));
  }

  async statistics(): Promise<ProviderStatistics> {
    const { rows } = await this.db.query<{ users: string; groups: string }>(
      `select
         (select count(*) from proxy_users where status = 'ACTIVE')::text as users,
         (select count(*) from proxy_groups where source = 'LOCAL')::text as groups`,
    );
    return { users: Number(rows[0]?.users ?? '0'), groups: Number(rows[0]?.groups ?? '0') };
  }

  async testConnection(): Promise<ProviderTestResult> {
    try {
      const stats = await this.statistics();
      return {
        ok: true,
        summary: `Local authentication provider ready. ${stats.users} active users, ${stats.groups} groups.`,
        checks: [
          { label: 'Local authentication provider ready', ok: true },
          { label: `${stats.users} active users`, ok: true },
          { label: `${stats.groups} groups`, ok: true },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        summary: 'Local user store is not reachable.',
        checks: [
          {
            label: 'Local user store reachable',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  async health() {
    if (!this.enabled) return disabledHealth();
    const started = Date.now();
    try {
      const stats = await this.statistics();
      return healthy(`${stats.users ?? 0} active users`, Date.now() - started);
    } catch (error) {
      return unreachable(error instanceof Error ? error.message : String(error));
    }
  }

  toIr(): IrAuthenticationProvider {
    return {
      key: this.key,
      type: 'LOCAL',
      name: this.name,
      priority: this.priority,
      helper: { kind: 'NCSA', passwordFile: this.passwordFile, children: 20 },
    };
  }
}
