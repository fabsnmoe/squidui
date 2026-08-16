/**
 * Audit event catalogue.
 *
 * Passwords and authentication test credentials must never appear in an audit
 * payload (PLAN.md 9.21). `redactAuditPayload` is the single enforcement point
 * and is applied by the API sink to every event, regardless of caller.
 */

export const AUDIT_ACTIONS = [
  // Control plane session
  'CP_LOGIN_SUCCEEDED',
  'CP_LOGIN_FAILED',
  'CP_LOGOUT',
  'CP_USER_CREATED',
  'CP_USER_UPDATED',
  'CP_USER_DELETED',

  // Proxy identity (PLAN.md 9.21)
  'PROXY_USER_CREATED',
  'PROXY_USER_UPDATED',
  'PROXY_USER_DISABLED',
  'PROXY_USER_DELETED',
  'PROXY_USER_PASSWORD_CHANGED',

  'PROXY_GROUP_CREATED',
  'PROXY_GROUP_UPDATED',
  'PROXY_GROUP_DELETED',

  'AUTH_MODE_CHANGED',
  'AUTH_DEFAULT_ACCESS_CHANGED',
  'AUTH_OPEN_PROXY_ACKNOWLEDGED',

  'AUTH_PROVIDER_CREATED',
  'AUTH_PROVIDER_UPDATED',
  'AUTH_PROVIDER_ENABLED',
  'AUTH_PROVIDER_DISABLED',
  'AUTH_PROVIDER_DELETED',
  'AUTH_PROVIDER_TESTED',
  'AUTH_TEST_PERFORMED',

  // Proxy self-service portal
  'PROXY_PORTAL_LOGIN_SUCCEEDED',
  'PROXY_PORTAL_LOGIN_FAILED',
  'PROXY_PORTAL_LOGOUT',
  'PROXY_USER_SELF_PASSWORD_CHANGED',

  // Policies and configuration
  'POLICY_RULE_CREATED',
  'POLICY_RULE_UPDATED',
  'POLICY_RULE_DELETED',
  'POLICY_RULES_REORDERED',
  'NETWORK_CREATED',
  'NETWORK_UPDATED',
  'NETWORK_DELETED',
  'LISTENER_CREATED',
  'LISTENER_UPDATED',
  'LISTENER_DELETED',
  'CONFIG_COMPILED',
  'CONFIG_DEPLOYED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';

export interface AuditEvent {
  id: string;
  occurredAt: string;
  action: AuditAction;
  outcome: AuditOutcome;
  actorId: string | null;
  actorUsername: string | null;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  sourceIp: string | null;
  payload: Record<string, unknown>;
}

/**
 * Keys that must never be persisted. Matching is case-insensitive and applies
 * at every nesting level.
 */
const FORBIDDEN_KEYS = [
  'password',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'passwordconfirm',
  'passwordhash',
  'password_hash',
  'secret',
  'bindpassword',
  'bind_password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'credentials',
  'apikey',
  'api_key',
  'privatekey',
];

export const REDACTED = '[redacted]';

function isForbidden(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
  return FORBIDDEN_KEYS.some((forbidden) => normalised.includes(forbidden.replace(/[^a-z]/g, '')));
}

/**
 * Recursively removes secret-bearing values. Returns a new object; the input is
 * never mutated.
 */
export function redactAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => redactAuditPayload(entry, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isForbidden(key) ? REDACTED : redactAuditPayload(entry, depth + 1);
  }
  return out;
}

export function describeAuditAction(action: AuditAction): string {
  return action
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
