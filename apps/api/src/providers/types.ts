import type {
  AuthenticationProviderType,
  IdentityGroupRef,
  IrAuthenticationProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '@scp/shared';

/**
 * `AuthenticationProviderAdapter` (PLAN.md 9.6).
 *
 * The registry only ever talks to this interface, which is what makes
 * "Local + LDAP in parallel" a matter of ordering adapters rather than special
 * casing provider types.
 */

export interface AuthenticationAttempt {
  username: string;
  /** Plaintext, in memory only for the duration of the call (PLAN.md 9.5). */
  password: string;
  sourceIp?: string | null;
}

export type AuthenticationOutcome =
  | {
      outcome: 'SUCCESS';
      username: string;
      displayName: string | null;
      groups: IdentityGroupRef[];
    }
  | { outcome: 'REJECTED'; message: string }
  | { outcome: 'UNAVAILABLE'; message: string };

export interface ProviderTestCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  summary: string;
  checks: ProviderTestCheck[];
}

export interface ProviderStatistics {
  users: number | null;
  groups: number | null;
}

export interface AuthenticationProviderAdapter {
  readonly id: string;
  readonly key: string;
  readonly type: AuthenticationProviderType;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;

  capabilities(): ProviderCapabilities;
  authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationOutcome>;
  testConnection(): Promise<ProviderTestResult>;
  health(): Promise<ProviderHealth>;
  statistics(): Promise<ProviderStatistics>;
  /** Provider fragment for the configuration IR, never containing a secret. */
  toIr(): IrAuthenticationProvider;
}

export function healthy(message: string, latencyMs?: number): ProviderHealth {
  return {
    state: 'HEALTHY',
    message,
    checkedAt: new Date().toISOString(),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

export function unreachable(message: string): ProviderHealth {
  return { state: 'UNREACHABLE', message, checkedAt: new Date().toISOString() };
}

export function disabledHealth(): ProviderHealth {
  return {
    state: 'DISABLED',
    message: 'Provider is disabled and is not consulted during authentication.',
    checkedAt: new Date().toISOString(),
  };
}
