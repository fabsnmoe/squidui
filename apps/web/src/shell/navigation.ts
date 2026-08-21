import type { Permission } from '@scp/shared';
import type { IconName } from '@scp/ui';

/**
 * Single source of truth for navigation (docs/design/navigation.md).
 * Sidebar, command palette and route guards all read from here, so a new page
 * can never appear in one place and be missing from another.
 */

export interface NavItem {
  label: string;
  to: string;
  icon: IconName;
  permission: Permission;
  /** Extra terms that should match in the command palette. */
  keywords?: string[];
  /** Marks the route as an exact match for the active state. */
  end?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        label: 'Dashboard',
        to: '/',
        icon: 'dashboard',
        permission: 'DASHBOARD_READ',
        end: true,
        keywords: ['home', 'status', 'health'],
      },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Nodes', to: '/nodes', icon: 'server', permission: 'NODE_READ', keywords: ['proxy', 'agent'] },
      {
        label: 'Node groups',
        to: '/node-groups',
        icon: 'server',
        permission: 'NODE_READ',
        keywords: ['site', 'location', 'scope', 'hierarchy'],
      },
      {
        label: 'Listeners',
        to: '/listeners',
        icon: 'listener',
        permission: 'LISTENER_READ',
        keywords: ['port', 'bind', 'http_port'],
      },
    ],
  },
  {
    label: 'Policies',
    items: [
      {
        label: 'Access rules',
        to: '/policies/rules',
        icon: 'rules',
        permission: 'POLICY_READ',
        keywords: ['allow', 'deny', 'acl'],
      },
      {
        label: 'Networks',
        to: '/policies/networks',
        icon: 'network',
        permission: 'POLICY_READ',
        keywords: ['cidr', 'subnet', 'source'],
      },
    ],
  },
  {
    label: 'Authentication',
    items: [
      {
        label: 'Overview',
        to: '/authentication',
        icon: 'shield',
        permission: 'PROXY_AUTH_READ',
        end: true,
        keywords: ['mode', 'required', 'optional', 'disabled'],
      },
      {
        label: 'Providers',
        to: '/authentication/providers',
        icon: 'key',
        permission: 'AUTH_PROVIDER_READ',
        keywords: ['ldap', 'local', 'priority'],
      },
      {
        label: 'Local users',
        to: '/authentication/users',
        icon: 'users',
        permission: 'PROXY_USER_READ',
        keywords: ['proxy user', 'service account', 'password'],
      },
      {
        label: 'Groups',
        to: '/authentication/groups',
        icon: 'group',
        permission: 'PROXY_GROUP_READ',
        keywords: ['logical group', 'ldap group'],
      },
      {
        label: 'Test',
        to: '/authentication/test',
        icon: 'test',
        permission: 'AUTH_PROVIDER_TEST',
        keywords: ['verify', 'credentials', 'try'],
      },
    ],
  },
  {
    label: 'Configuration',
    items: [
      {
        label: 'Review',
        to: '/configuration/review',
        icon: 'file',
        permission: 'CONFIG_READ',
        keywords: ['squid.conf', 'compile', 'generated'],
      },
    ],
  },
  {
    label: 'Observability',
    items: [
      {
        label: 'Statistics',
        to: '/observability/statistics',
        icon: 'dashboard',
        permission: 'TRAFFIC_READ',
        keywords: ['kpi', 'bandwidth', 'usage', 'trend', 'per user', 'per node'],
      },
      {
        label: 'Traffic logs',
        to: '/observability/logs',
        icon: 'file',
        permission: 'TRAFFIC_READ',
        keywords: ['requests', 'access log', 'who visited', 'denied'],
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Identity providers',
        to: '/system/identity-providers',
        icon: 'key',
        permission: 'CP_USER_READ',
        keywords: ['oidc', 'keycloak', 'sso', 'single sign-on', 'openid'],
      },
      {
        label: 'Audit log',
        to: '/system/audit',
        icon: 'audit',
        permission: 'AUDIT_READ',
        keywords: ['events', 'history', 'who'],
      },
      {
        label: 'Settings',
        to: '/system/settings',
        icon: 'settings',
        permission: 'SETTINGS_READ',
        keywords: ['account', 'password', 'version'],
      },
    ],
  },
];

export function visibleNavigation(can: (permission: Permission) => boolean): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.permission)),
  })).filter((group) => group.items.length > 0);
}
