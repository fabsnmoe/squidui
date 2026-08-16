import { describe, expect, it } from 'vitest';
import { compileConfiguration, slug } from './compiler.js';
import { SQUID_6_DEBIAN } from './adapter.js';
import { createEmptyIr, type ConfigurationIr, type IrAuthenticationProvider, type PolicyRule } from '../policy/ir.js';

const localProvider: IrAuthenticationProvider = {
  key: 'local',
  type: 'LOCAL',
  name: 'Local users',
  priority: 10,
  helper: { kind: 'NCSA', passwordFile: '/etc/squid/scp/local_users', children: 10 },
};

const ldapProvider: IrAuthenticationProvider = {
  key: 'ldap-company',
  type: 'LDAP',
  name: 'Company LDAP',
  priority: 20,
  helper: {
    kind: 'LDAP',
    uri: 'ldaps://ldap.example.internal',
    baseDn: 'ou=people,dc=example,dc=internal',
    userFilter: '(uid=%s)',
    bindDn: 'cn=squid,ou=services,dc=example,dc=internal',
    bindPasswordRef: 'ldap-company.secret',
    useTls: true,
    groupBaseDn: 'ou=groups,dc=example,dc=internal',
    groupFilter: '(&(objectClass=groupOfNames)(member=%u)(cn=%g))',
    children: 10,
  },
};

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'position'>): PolicyRule {
  return {
    name: `Rule ${overrides.position}`,
    enabled: true,
    action: 'ALLOW',
    source: { kind: 'ANY' },
    identity: { kind: 'ANY' },
    destination: { kind: 'ANY' },
    schedule: { kind: 'ALWAYS' },
    ...overrides,
  };
}

function compile(ir: ConfigurationIr, localUsers: Parameters<typeof compileConfiguration>[1] = {}) {
  return compileConfiguration(ir, { adapter: SQUID_6_DEBIAN, ...localUsers });
}

describe('slug', () => {
  it('produces safe ACL name fragments', () => {
    expect(slug('Guest network')).toBe('guest_network');
    expect(slug('CN=Developers,OU=Groups')).toBe('cn_developers_ou_groups');
    expect(slug('   ')).toBe('x');
  });
});

describe('compiler - authentication disabled', () => {
  const ir = createEmptyIr({
    authentication: { mode: 'DISABLED', realm: 'Squid', providers: [], localGroupMembers: {} },
    defaultAccess: 'ALLOW',
    listeners: [{ id: 'l', key: 'default', name: 'Default', address: '0.0.0.0', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'DISABLED', sourceNetworks: [] }],
    rules: [rule({ id: 'r1', position: 10, name: 'Allow any' })],
  });

  it('emits no auth_param and allows anonymous traffic', () => {
    const result = compile(ir);
    expect(result.squidConf).not.toContain('auth_param');
    expect(result.squidConf).toContain('http_access allow all');
    expect(result.squidConf).toContain('http_port 0.0.0.0:3128');
  });

  it('still reports the open proxy finding', () => {
    expect(compile(ir).findings.map((finding) => finding.code)).toContain('OPEN_PROXY');
  });

  it('omits rules that would need an identity', () => {
    const withIdentityRule = createEmptyIr({
      ...ir,
      rules: [rule({ id: 'r1', position: 10, identity: { kind: 'AUTHENTICATED' } })],
    });
    const result = compile(withIdentityRule);
    expect(result.squidConf).toContain('omitted');
    expect(result.warnings.map((warning) => warning.code)).toContain('IDENTITY_RULE_WITHOUT_AUTH');
  });
});

describe('compiler - required mode with the local provider', () => {
  const ir = createEmptyIr({
    authentication: {
      mode: 'REQUIRED',
      realm: 'Squid Control Plane',
      providers: [localProvider],
      localGroupMembers: { Services: ['service-api', 'service-batch'] },
    },
    defaultAccess: 'DENY',
    listeners: [{ id: 'l', key: 'default', name: 'Default', address: '10.0.0.5', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'REQUIRED', sourceNetworks: [] }],
    rules: [
      rule({
        id: 'r10',
        position: 10,
        name: 'Services to internal APIs',
        identity: { kind: 'GROUP', groups: [{ source: 'LOCAL', name: 'Services', providerKey: null }] },
        destination: { kind: 'SPECIFIC', domains: ['.internal.example'], ports: [443] },
      }),
    ],
  });

  it('wires up basic_ncsa_auth with the generated password file', () => {
    const result = compile(ir);
    expect(result.squidConf).toContain(
      'auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/scp/local_users',
    );
    expect(result.squidConf).toContain('auth_param basic realm Squid Control Plane');
    expect(result.squidConf).toContain('acl scp_authenticated proxy_auth REQUIRED');
  });

  it('challenges unauthenticated clients before any rule', () => {
    const conf = compile(ir).squidConf;
    const challengeIndex = conf.indexOf('http_access deny scp_lp_default !scp_authenticated');
    const ruleIndex = conf.indexOf('# Rule 10');
    expect(challengeIndex).toBeGreaterThan(-1);
    expect(challengeIndex).toBeLessThan(ruleIndex);
  });

  it('expands a local group into a concrete user list', () => {
    expect(compile(ir).squidConf).toContain(
      'acl scp_grp_local_services proxy_auth service-api service-batch',
    );
  });

  it('emits destination and port ACLs and combines them on the access line', () => {
    const conf = compile(ir).squidConf;
    expect(conf).toContain('acl scp_dst_r10_dom dstdomain .internal.example');
    expect(conf).toContain('acl scp_dst_r10_port port 443');
    expect(conf).toContain(
      'http_access allow scp_grp_local_services scp_dst_r10_dom scp_dst_r10_port',
    );
  });

  it('renders the NCSA password file with active users only', () => {
    const result = compile(ir, {
      localUsers: [
        { username: 'service-api', passwordHash: '$6$abc$hash1', status: 'ACTIVE' },
        { username: 'retired', passwordHash: '$6$abc$hash2', status: 'DISABLED' },
      ],
    });
    const artefact = result.artefacts.find((entry) => entry.path === '/etc/squid/scp/local_users');
    expect(artefact).toBeDefined();
    expect(artefact?.sensitive).toBe(true);
    expect(artefact?.content).toBe('service-api:$6$abc$hash1\n');
  });

  /*
   * Regression: mode 0640 owned by root:root makes basic_ncsa_auth exit with
   * "Permission denied", because Squid drops privileges before starting its
   * helpers - every request then answers 407. Found by testing against a real
   * Squid, so the artefact contract carries ownership, not just a mode.
   */
  it('declares ownership the authentication helper can actually read', () => {
    const result = compile(ir, {
      localUsers: [{ username: 'service-api', passwordHash: '$6$abc$hash1', status: 'ACTIVE' }],
    });
    const artefact = result.artefacts.find((entry) => entry.path === '/etc/squid/scp/local_users');
    expect(artefact?.mode).toBe('0640');
    expect(artefact?.owner).toBe(SQUID_6_DEBIAN.runtimeUser);
    expect(artefact?.group).toBe(SQUID_6_DEBIAN.runtimeGroup);
    expect(artefact?.group).not.toBe('root');
  });

  it('warns about a local user without a password', () => {
    const result = compile(ir, {
      localUsers: [{ username: 'no-password', passwordHash: '', status: 'ACTIVE' }],
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('USER_WITHOUT_PASSWORD');
  });

  it('is deterministic', () => {
    expect(compile(ir).squidConf).toBe(compile(ir).squidConf);
  });
});

describe('compiler - multiple providers in parallel', () => {
  const ir = createEmptyIr({
    authentication: {
      mode: 'REQUIRED',
      realm: 'Squid',
      providers: [localProvider, ldapProvider],
      localGroupMembers: {},
    },
    defaultAccess: 'DENY',
    listeners: [{ id: 'l', key: 'default', name: 'Default', address: '10.0.0.5', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'REQUIRED', sourceNetworks: [] }],
    rules: [rule({ id: 'r10', position: 10, identity: { kind: 'AUTHENTICATED' } })],
  });

  it('uses the generated multiplexer and ships it as an artefact', () => {
    const result = compile(ir);
    expect(result.squidConf).toContain(
      'auth_param basic program /etc/squid/scp/scp_multi_basic_auth',
    );
    expect(result.warnings.map((warning) => warning.code)).toContain('MULTI_PROVIDER_HELPER');
    const helper = result.artefacts.find((entry) => entry.path === '/etc/squid/scp/scp_multi_basic_auth');
    expect(helper?.mode).toBe('0750');
    expect(helper?.content).toContain('basic_ncsa_auth');
    expect(helper?.content).toContain('basic_ldap_auth');
  });

  it('references the bind password by file and never inlines it', () => {
    const result = compile(ir, { providerSecrets: { 'ldap-company': 'bind-secret-value' } });
    // With two providers the helper command lives in the multiplexer, not in
    // squid.conf, so the reference is asserted there.
    const multiplexer = result.artefacts.find((entry) => entry.path.endsWith('scp_multi_basic_auth'));
    expect(multiplexer?.content).toContain('/etc/squid/scp/secrets/ldap-company.secret');
    expect(result.squidConf).not.toContain('bind-secret-value');
    expect(multiplexer?.content).not.toContain('bind-secret-value');
  });

  /*
   * Regression: the compiler referenced a bind password file through -W but
   * never produced it, so basic_ldap_auth could not bind and every directory
   * user got a 407. Found by driving traffic through a real Squid.
   */
  it('emits the bind password file the LDAP helper reads', () => {
    const result = compile(ir, { providerSecrets: { 'ldap-company': 'bind-secret-value' } });
    const secret = result.artefacts.find((entry) => entry.path === '/etc/squid/scp/secrets/ldap-company.secret');
    expect(secret).toBeDefined();
    expect(secret?.sensitive).toBe(true);
    expect(secret?.mode).toBe('0640');
    expect(secret?.content).toBe('bind-secret-value\n');
  });

  it('omits the secret and says so when none was supplied', () => {
    const result = compile(ir);
    expect(result.artefacts.some((entry) => entry.path.includes('secrets/'))).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('BIND_SECRET_NOT_AVAILABLE');
  });
});

describe('compiler - LDAP groups', () => {
  const ir = createEmptyIr({
    authentication: {
      mode: 'REQUIRED',
      realm: 'Squid',
      providers: [ldapProvider],
      localGroupMembers: {},
    },
    defaultAccess: 'DENY',
    listeners: [{ id: 'l', key: 'default', name: 'Default', address: '10.0.0.5', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'REQUIRED', sourceNetworks: [] }],
    rules: [
      rule({
        id: 'r10',
        position: 10,
        identity: {
          kind: 'GROUP',
          groups: [
            {
              source: 'LOGICAL',
              name: 'Developer access',
              providerKey: null,
              expandsTo: [
                { source: 'EXTERNAL', name: 'Developers', providerKey: 'ldap-company' },
                { source: 'EXTERNAL', name: 'Platform', providerKey: 'ldap-company' },
              ],
            },
          ],
        },
      }),
    ],
  });

  it('declares an external_acl_type once and one ACL per group', () => {
    const conf = compile(ir).squidConf;
    expect(conf.match(/external_acl_type scp_ldapgrp_ldap_company/g)).toHaveLength(1);
    expect(conf).toContain('acl scp_grp_ldap_company_developers external scp_ldapgrp_ldap_company "Developers"');
    expect(conf).toContain('acl scp_grp_ldap_company_platform external scp_ldapgrp_ldap_company "Platform"');
  });

  it('expands a multi-group OR into one access line per group', () => {
    const conf = compile(ir).squidConf;
    expect(conf).toContain('http_access allow scp_grp_ldap_company_developers');
    expect(conf).toContain('http_access allow scp_grp_ldap_company_platform');
  });
});

describe('compiler - unauthenticated identity', () => {
  const optionalIr = (rules: PolicyRule[]): ConfigurationIr =>
    createEmptyIr({
      authentication: {
        mode: 'OPTIONAL',
        realm: 'Squid',
        providers: [localProvider],
        localGroupMembers: {},
      },
      defaultAccess: 'DENY',
      // A corporate listener next to a guest one: that mixture is what makes the
      // identity mode optional now, rather than a global switch.
      listeners: [
        { id: 'l1', key: 'corporate', name: 'Corporate', address: '10.0.0.5', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'REQUIRED', sourceNetworks: [] },
        { id: 'l2', key: 'guest', name: 'Guest', address: '10.0.0.5', port: 3129, mode: 'FORWARD', enabled: true, authentication: 'DISABLED', sourceNetworks: [] },
      ],
      rules,
    });

  /*
   * Regression from testing against a real Squid: compiling UNAUTHENTICATED as
   * `!scp_authenticated` challenges exactly the anonymous clients the rule is
   * meant to admit, because Squid asks for credentials as soon as it evaluates
   * any proxy_auth backed ACL - negated or not. Scenario E returned 407 instead
   * of 200 until this was fixed.
   */
  it('does not reference proxy_auth for an unauthenticated rule in optional mode', () => {
    const result = compile(
      optionalIr([
        rule({
          id: 'r10',
          position: 10,
          name: 'Guest network',
          source: { kind: 'NETWORKS', networks: [{ id: 'n', name: 'Guest', cidrs: ['10.20.0.0/24'] }] },
          identity: { kind: 'UNAUTHENTICATED' },
          destination: { kind: 'SPECIFIC', ports: [80] },
        }),
      ]),
    );
    // The corporate listener guard legitimately references proxy_auth; what must
    // not happen is the *rule* doing so, because that challenges the very
    // clients it is meant to admit.
    const ruleLine = result.squidConf
      .split(String.fromCharCode(10))
      .find((line) => line.startsWith('http_access allow scp_net_guest'));
    expect(ruleLine).toBeDefined();
    expect(ruleLine).not.toContain('scp_authenticated');
    expect(result.squidConf).toContain('http_access allow scp_net_guest scp_dst_r10_port');
  });

  it('reports the widening instead of applying it silently', () => {
    const result = compile(optionalIr([rule({ id: 'r10', position: 10, identity: { kind: 'UNAUTHENTICATED' } })]));
    const warning = result.warnings.find((entry) => entry.code === 'UNAUTHENTICATED_WIDENED');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('Authenticated clients meeting the same conditions therefore match it too');
  });

  it('omits an unauthenticated rule in required mode, where it can never match', () => {
    const ir = createEmptyIr({
      authentication: { mode: 'REQUIRED', realm: 'Squid', providers: [localProvider], localGroupMembers: {} },
      defaultAccess: 'DENY',
      listeners: [{ id: 'l', key: 'default', name: 'Default', address: '10.0.0.5', port: 3128, mode: 'FORWARD', enabled: true, authentication: 'REQUIRED', sourceNetworks: [] }],
      rules: [rule({ id: 'r10', position: 10, identity: { kind: 'UNAUTHENTICATED' } })],
    });
    const result = compile(ir);
    expect(result.warnings.map((warning) => warning.code)).toContain('UNAUTHENTICATED_RULE_IN_REQUIRED_MODE');
    expect(result.squidConf).toContain('omitted');
  });

  it('warns when an unauthenticated rule sits below an authenticated rule', () => {
    const result = compile(
      optionalIr([
        rule({ id: 'r10', position: 10, identity: { kind: 'AUTHENTICATED' } }),
        rule({ id: 'r20', position: 20, identity: { kind: 'UNAUTHENTICATED' } }),
      ]),
    );
    expect(result.warnings.map((warning) => warning.code)).toContain('OPTIONAL_MODE_RULE_ORDER');
  });
});
