/**
 * Proxy identity model.
 *
 * Everything in this file describes the *proxy* identity plane. Control plane
 * accounts (web UI login, RBAC) are a separate model and must never share a
 * table, a type or a password store with these (PRODUCT.md section 1).
 */

/** Global proxy authentication mode (PRODUCT.md section 2, PLAN.md 9.2). */
export const AUTHENTICATION_MODES = ['DISABLED', 'OPTIONAL', 'REQUIRED'] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

export function isAuthenticationMode(value: unknown): value is AuthenticationMode {
  return typeof value === 'string' && (AUTHENTICATION_MODES as readonly string[]).includes(value);
}

export const PROVIDER_TYPES = ['LOCAL', 'LDAP'] as const;
export type AuthenticationProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'UNREACHABLE',
  'DISABLED',
  'UNKNOWN',
] as const;
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

export interface ProviderHealth {
  state: ProviderHealthState;
  message: string;
  checkedAt: string;
  /** Round trip time of the last probe in milliseconds, when measured. */
  latencyMs?: number;
}

/**
 * What a provider is able to do. The registry uses this to decide whether a
 * capability (e.g. group lookup) can be offered in the UI at all.
 */
export interface ProviderCapabilities {
  authenticate: boolean;
  userLookup: boolean;
  groupLookup: boolean;
  passwordManagement: boolean;
  connectionTest: boolean;
}

export interface AuthenticationProviderSummary {
  id: string;
  /** Stable key used in the IR and in generated configuration, e.g. `local`. */
  key: string;
  type: AuthenticationProviderType;
  name: string;
  enabled: boolean;
  priority: number;
  capabilities: ProviderCapabilities;
  health: ProviderHealth;
}

/** PRODUCT.md section 25. */
export interface ProxyAuthenticationConfiguration {
  mode: AuthenticationMode;
  /** Fallback decision when no rule matches. */
  defaultAccess: 'ALLOW' | 'DENY';
  realm: string;
  providers: Array<{
    id: string;
    key: string;
    enabled: boolean;
    priority: number;
  }>;
  /**
   * Set when an operator knowingly accepted an open proxy configuration.
   * Recorded so the audit trail shows the decision was deliberate.
   */
  openProxyAcknowledgedAt: string | null;
  openProxyAcknowledgedBy: string | null;
  updatedAt: string;
}

export const PROXY_USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type ProxyUserStatus = (typeof PROXY_USER_STATUSES)[number];

/** PRODUCT.md section 14. Never carries a password field. */
export interface ProxyUser {
  id: string;
  username: string;
  displayName: string | null;
  description: string | null;
  status: ProxyUserStatus;
  groups: ProxyGroupRef[];
  passwordUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyGroupRef {
  id: string;
  name: string;
}

export const GROUP_SOURCES = ['LOCAL', 'EXTERNAL', 'LOGICAL'] as const;
export type GroupSource = (typeof GROUP_SOURCES)[number];

export interface ProxyGroup {
  id: string;
  name: string;
  description: string | null;
  source: GroupSource;
  /** Only set for EXTERNAL groups: which provider the group came from. */
  providerKey: string | null;
  /** Distinguished name or provider specific identifier for EXTERNAL groups. */
  externalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A logical group unifies groups from different sources so policies can refer
 * to one name (PRODUCT.md section 18).
 */
export interface LogicalIdentityGroup {
  id: string;
  name: string;
  description: string | null;
  members: LogicalIdentityGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface LogicalIdentityGroupMember {
  source: Exclude<GroupSource, 'LOGICAL'>;
  groupId: string;
  groupName: string;
  providerKey: string | null;
}

/** Result of `Authentication -> Test` (PRODUCT.md section 22). */
export interface AuthenticationTestResult {
  success: boolean;
  providerKey: string | null;
  providerName: string | null;
  username: string;
  groups: string[];
  message: string;
  /** Per-provider outcome, so a partial outage is visible in the result. */
  attempts: Array<{
    providerKey: string;
    providerName: string;
    outcome: 'SUCCESS' | 'REJECTED' | 'UNAVAILABLE' | 'SKIPPED';
    message: string;
    durationMs: number;
  }>;
}

export function sortProvidersByPriority<T extends { priority: number; key: string }>(
  providers: readonly T[],
): T[] {
  // Deterministic order: priority first, key as tie breaker (PRODUCT.md 12).
  return [...providers].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

export function describeAuthenticationMode(mode: AuthenticationMode): string {
  switch (mode) {
    case 'DISABLED':
      return 'Squid does not request proxy credentials. Clients may access the proxy without credentials.';
    case 'OPTIONAL':
      return 'Authenticated and anonymous clients are both accepted. Rules decide what each may reach.';
    case 'REQUIRED':
      return 'Clients must authenticate before any rule requiring an authenticated identity applies.';
  }
}
