import {
  sortProvidersByPriority,
  type AuthenticationProviderSummary,
  type AuthenticationTestResult,
  type ProviderHealth,
} from '@scp/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { decryptSecret } from '../security/secrets.js';
import { LdapAuthenticationProvider } from './ldap.js';
import { LocalAuthenticationProvider } from './local.js';
import type { AuthenticationAttempt, AuthenticationProviderAdapter } from './types.js';

/**
 * `AuthenticationProviderRegistry` (PLAN.md 9.8).
 *
 * Holds every configured provider with its enabled flag, priority, health and
 * capabilities, and runs authentication across all enabled providers in
 * priority order.
 */

interface ProviderRow {
  id: string;
  key: string;
  type: 'LOCAL' | 'LDAP';
  name: string;
  enabled: boolean;
  priority: number;
  config: unknown;
}

const HEALTH_CACHE_TTL_MS = 30_000;

interface CachedHealth {
  health: ProviderHealth;
  expiresAt: number;
}

const healthCache = new Map<string, CachedHealth>();

export class AuthenticationProviderRegistry {
  private constructor(private readonly adapters: AuthenticationProviderAdapter[]) {}

  static async load(db: Db, config: AppConfig): Promise<AuthenticationProviderRegistry> {
    const { rows } = await db.query<ProviderRow>(
      'select id, key, type, name, enabled, priority, config from auth_providers order by priority, key',
    );

    const adapters: AuthenticationProviderAdapter[] = [];
    for (const row of rows) {
      if (row.type === 'LOCAL') {
        adapters.push(new LocalAuthenticationProvider(db, row, '/etc/squid/scp/local_users'));
      } else {
        adapters.push(
          new LdapAuthenticationProvider(
            row,
            async () => {
              const { rows: secretRows } = await db.query<{ ciphertext: string }>(
                'select ciphertext from provider_secrets where provider_id = $1 and name = $2',
                [row.id, 'bindPassword'],
              );
              const ciphertext = secretRows[0]?.ciphertext;
              return ciphertext ? decryptSecret(ciphertext, config.secretEncryptionKey) : null;
            },
            '/etc/squid/scp/secrets',
          ),
        );
      }
    }

    return new AuthenticationProviderRegistry(sortProvidersByPriority(adapters));
  }

  all(): AuthenticationProviderAdapter[] {
    return this.adapters;
  }

  enabled(): AuthenticationProviderAdapter[] {
    return this.adapters.filter((adapter) => adapter.enabled);
  }

  byKey(key: string): AuthenticationProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.key === key);
  }

  byId(id: string): AuthenticationProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  /**
   * Tries every enabled provider in priority order.
   *
   * - SUCCESS stops the chain.
   * - REJECTED continues, because the same username may exist in a later
   *   provider (a local emergency account next to an LDAP account).
   * - UNAVAILABLE continues and is reported, so an LDAP outage degrades the
   *   result instead of failing it (PLAN.md 9.9).
   */
  async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationTestResult> {
    const attempts: AuthenticationTestResult['attempts'] = [];
    const enabled = this.enabled();

    for (const adapter of this.adapters) {
      if (!adapter.enabled) {
        attempts.push({
          providerKey: adapter.key,
          providerName: adapter.name,
          outcome: 'SKIPPED',
          message: 'Provider is disabled.',
          durationMs: 0,
        });
        continue;
      }

      const started = Date.now();
      const result = await adapter.authenticate(attempt);
      const durationMs = Date.now() - started;
      attempts.push({
        providerKey: adapter.key,
        providerName: adapter.name,
        outcome: result.outcome,
        message: result.outcome === 'SUCCESS' ? 'Authentication successful.' : result.message,
        durationMs,
      });

      if (result.outcome === 'SUCCESS') {
        return {
          success: true,
          providerKey: adapter.key,
          providerName: adapter.name,
          username: result.username,
          groups: result.groups.map((group) => group.name),
          message: 'Authentication successful',
          attempts,
        };
      }
    }

    const unavailable = attempts.filter((entry) => entry.outcome === 'UNAVAILABLE');
    const message =
      enabled.length === 0
        ? 'No authentication provider is enabled.'
        : unavailable.length > 0
          ? `Authentication failed. ${unavailable.length} of ${enabled.length} providers were unavailable.`
          : 'Authentication failed: unknown user or invalid credentials.';

    return {
      success: false,
      providerKey: null,
      providerName: null,
      username: attempt.username,
      groups: [],
      message,
      attempts,
    };
  }

  /** Health of every provider, cached briefly so list views stay responsive. */
  async summaries(options: { refresh?: boolean } = {}): Promise<AuthenticationProviderSummary[]> {
    const now = Date.now();
    const out: AuthenticationProviderSummary[] = [];

    for (const adapter of this.adapters) {
      const cached = healthCache.get(adapter.id);
      let health: ProviderHealth;
      if (!options.refresh && cached && cached.expiresAt > now) {
        health = cached.health;
      } else {
        health = await adapter.health();
        healthCache.set(adapter.id, { health, expiresAt: now + HEALTH_CACHE_TTL_MS });
      }

      out.push({
        id: adapter.id,
        key: adapter.key,
        type: adapter.type,
        name: adapter.name,
        enabled: adapter.enabled,
        priority: adapter.priority,
        capabilities: adapter.capabilities(),
        health,
      });
    }

    return out;
  }

  static invalidateHealth(providerId?: string): void {
    if (providerId) healthCache.delete(providerId);
    else healthCache.clear();
  }
}
