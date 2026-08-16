/**
 * Squid version adapter.
 *
 * Everything that differs between Squid builds - helper paths, directive
 * spellings, supported ACL types - is isolated here so the compiler itself
 * stays version agnostic (docs/architecture/overview.md).
 */

export interface SquidVersionAdapter {
  id: string;
  displayName: string;
  /** Squid versions this adapter targets, for display and validation. */
  supports: string;
  helpers: {
    ncsaAuth: string;
    ldapAuth: string;
    ldapGroupAcl: string;
    /** Generated multiplexer used when more than one provider is enabled. */
    multiProviderAuth: string;
  };
  paths: {
    /** Directory the control plane owns on the proxy node. */
    generatedDir: string;
    ncsaPasswordFile: string;
    secretsDir: string;
    /** Access log the agent tails and ships to the control plane. */
    accessLog: string;
  };
  /** crypt(3) format the bundled `basic_ncsa_auth` can verify. */
  passwordHashFormat: 'sha512-crypt' | 'md5-crypt';
  /**
   * Account Squid drops privileges to. Authentication helpers run as this
   * user, so every generated artefact the helpers read must be readable by it -
   * a file owned by root with mode 0640 makes `basic_ncsa_auth` die with
   * "Permission denied" and every request answered with 407.
   */
  runtimeUser: string;
  runtimeGroup: string;
}

export const SQUID_6_DEBIAN: SquidVersionAdapter = {
  id: 'squid-6-debian',
  displayName: 'Squid 6 (Debian/Ubuntu layout)',
  supports: '6.x',
  helpers: {
    ncsaAuth: '/usr/lib/squid/basic_ncsa_auth',
    ldapAuth: '/usr/lib/squid/basic_ldap_auth',
    ldapGroupAcl: '/usr/lib/squid/ext_ldap_group_acl',
    multiProviderAuth: '/etc/squid/scp/scp_multi_basic_auth',
  },
  paths: {
    generatedDir: '/etc/squid/scp',
    ncsaPasswordFile: '/etc/squid/scp/local_users',
    secretsDir: '/etc/squid/scp/secrets',
    accessLog: '/var/log/squid/access.log',
  },
  passwordHashFormat: 'sha512-crypt',
  runtimeUser: 'root',
  runtimeGroup: 'proxy',
};

export const SQUID_6_ALPINE: SquidVersionAdapter = {
  ...SQUID_6_DEBIAN,
  id: 'squid-6-alpine',
  displayName: 'Squid 6 (Alpine layout)',
  helpers: {
    ncsaAuth: '/usr/lib/squid/basic_ncsa_auth',
    ldapAuth: '/usr/lib/squid/basic_ldap_auth',
    ldapGroupAcl: '/usr/lib/squid/ext_ldap_group_acl',
    multiProviderAuth: '/etc/squid/scp/scp_multi_basic_auth',
  },
  // musl's crypt() supports both, sha512-crypt stays the default.
  passwordHashFormat: 'sha512-crypt',
  runtimeUser: 'root',
  runtimeGroup: 'squid',
};

export const SQUID_ADAPTERS: SquidVersionAdapter[] = [SQUID_6_DEBIAN, SQUID_6_ALPINE];

export const DEFAULT_SQUID_ADAPTER = SQUID_6_DEBIAN;

export function getSquidAdapter(id: string | null | undefined): SquidVersionAdapter {
  if (!id) return DEFAULT_SQUID_ADAPTER;
  return SQUID_ADAPTERS.find((adapter) => adapter.id === id) ?? DEFAULT_SQUID_ADAPTER;
}
