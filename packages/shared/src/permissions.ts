/**
 * Control plane RBAC permissions.
 *
 * These govern access to the *control plane* (web UI and API). They have
 * nothing to do with proxy authentication - a proxy user never holds a
 * permission (PRODUCT.md section 1).
 */

export const PERMISSIONS = [
  // Dashboard and general read access
  'DASHBOARD_READ',

  // Infrastructure
  'NODE_READ',
  'NODE_MANAGE',
  'LISTENER_READ',
  'LISTENER_MANAGE',

  // Policies
  'POLICY_READ',
  'POLICY_MANAGE',

  // Configuration and deployment
  'CONFIG_READ',
  'CONFIG_COMPILE',
  'CONFIG_DEPLOY',

  // Proxy authentication (PLAN.md 9.20)
  'PROXY_AUTH_READ',
  'PROXY_AUTH_CONFIGURE',

  'PROXY_USER_READ',
  'PROXY_USER_CREATE',
  'PROXY_USER_UPDATE',
  'PROXY_USER_DELETE',
  'PROXY_USER_PASSWORD_RESET',

  'PROXY_GROUP_READ',
  'PROXY_GROUP_MANAGE',

  'AUTH_PROVIDER_READ',
  'AUTH_PROVIDER_MANAGE',
  'AUTH_PROVIDER_TEST',

  // System
  'AUDIT_READ',
  'SETTINGS_READ',
  'SETTINGS_MANAGE',
  'CP_USER_READ',
  'CP_USER_MANAGE',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export interface RoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
}

const READ_ONLY: Permission[] = [
  'DASHBOARD_READ',
  'NODE_READ',
  'LISTENER_READ',
  'POLICY_READ',
  'CONFIG_READ',
  'PROXY_AUTH_READ',
  'PROXY_USER_READ',
  'PROXY_GROUP_READ',
  'AUTH_PROVIDER_READ',
  'AUDIT_READ',
  'SETTINGS_READ',
];

/** Roles created on an empty database. */
export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    name: 'Administrator',
    description: 'Full control over the control plane, including deployment and user management.',
    permissions: [...PERMISSIONS],
  },
  {
    name: 'Policy Operator',
    description: 'Manages access rules, proxy identities and deployments, but not control plane accounts.',
    permissions: [
      ...READ_ONLY,
      'POLICY_MANAGE',
      'LISTENER_MANAGE',
      'CONFIG_COMPILE',
      'CONFIG_DEPLOY',
      'PROXY_AUTH_CONFIGURE',
      'PROXY_USER_CREATE',
      'PROXY_USER_UPDATE',
      'PROXY_USER_DELETE',
      'PROXY_USER_PASSWORD_RESET',
      'PROXY_GROUP_MANAGE',
      'AUTH_PROVIDER_MANAGE',
      'AUTH_PROVIDER_TEST',
    ],
  },
  {
    name: 'Proxy User Administrator',
    description: 'Manages local proxy users and groups without touching policies or deployment.',
    permissions: [
      'DASHBOARD_READ',
      'PROXY_AUTH_READ',
      'PROXY_USER_READ',
      'PROXY_USER_CREATE',
      'PROXY_USER_UPDATE',
      'PROXY_USER_DELETE',
      'PROXY_USER_PASSWORD_RESET',
      'PROXY_GROUP_READ',
      'PROXY_GROUP_MANAGE',
      'AUTH_PROVIDER_READ',
      'AUTH_PROVIDER_TEST',
    ],
  },
  {
    name: 'Auditor',
    description: 'Read-only access to every surface, including the audit log.',
    permissions: [...READ_ONLY],
  },
];

export function hasPermission(
  held: readonly string[] | undefined | null,
  required: Permission,
): boolean {
  if (!held) return false;
  return held.includes(required);
}

export function hasAnyPermission(
  held: readonly string[] | undefined | null,
  required: readonly Permission[],
): boolean {
  if (!held) return false;
  return required.some((permission) => held.includes(permission));
}
