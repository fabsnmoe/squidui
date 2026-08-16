import { describe, expect, it } from 'vitest';
import { detectSecurityFindings, hasOpenProxyFinding } from './openProxy.js';
import { createEmptyIr, type ConfigurationIr, type Listener, type PolicyRule } from './ir.js';

const publicListener: Listener = {
  id: 'l1',
  key: 'default',
  name: 'Default',
  address: '0.0.0.0',
  port: 3128,
  mode: 'FORWARD',
  enabled: true,
  authentication: 'DISABLED',
  inheritsAuthentication: false,
  sourceNetworks: [],
};

const privateListener: Listener = { ...publicListener, id: 'l2', address: '10.0.0.5' };

/** Same listener, but one that demands an identity. */
const authenticatedListener: Listener = {
  ...publicListener,
  id: 'l3',
  key: 'corporate',
  name: 'Corporate',
  authentication: 'REQUIRED',
};

function allowAnyRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'r1',
    position: 10,
    name: 'Allow any',
    enabled: true,
    action: 'ALLOW',
    source: { kind: 'ANY' },
    identity: { kind: 'ANY' },
    destination: { kind: 'ANY' },
    schedule: { kind: 'ALWAYS' },
    ...overrides,
  };
}

function disabledAuthIr(overrides: Partial<ConfigurationIr> = {}): ConfigurationIr {
  return createEmptyIr({
    authentication: { mode: 'DISABLED', realm: 'Squid', providers: [], localGroupMembers: {} },
    listeners: [publicListener],
    ...overrides,
  });
}

describe('open proxy detection', () => {
  it('flags authentication disabled + default allow on a wildcard listener as critical', () => {
    // PLAN.md 9.19
    const findings = detectSecurityFindings(disabledAuthIr({ defaultAccess: 'ALLOW' }));
    const openProxy = findings.find((finding) => finding.code === 'OPEN_PROXY');
    expect(openProxy).toBeDefined();
    expect(openProxy?.severity).toBe('CRITICAL');
    expect(openProxy?.detail).toContain('unauthenticated open proxy');
    expect(openProxy?.evidence).toContain('Listeners without authentication: Default');
    expect(openProxy?.evidence).toContain('Default access: ALLOW');
    expect(hasOpenProxyFinding(findings)).toBe(true);
  });

  it('flags an allow-any-source rule even when the default is deny', () => {
    const findings = detectSecurityFindings(
      disabledAuthIr({ defaultAccess: 'DENY', rules: [allowAnyRule()] }),
    );
    expect(hasOpenProxyFinding(findings)).toBe(true);
  });

  it('downgrades to a warning when every listener is on a private address', () => {
    const findings = detectSecurityFindings(
      disabledAuthIr({ defaultAccess: 'ALLOW', listeners: [privateListener] }),
    );
    expect(findings.find((finding) => finding.code === 'OPEN_PROXY')?.severity).toBe('WARNING');
  });

  it('reports only informational anonymous access for a private source network', () => {
    const findings = detectSecurityFindings(
      disabledAuthIr({
        defaultAccess: 'DENY',
        listeners: [privateListener],
        rules: [
          allowAnyRule({
            source: {
              kind: 'NETWORKS',
              networks: [{ id: 'n', name: 'Lab', cidrs: ['10.5.0.0/24'] }],
            },
          }),
        ],
      }),
    );
    expect(hasOpenProxyFinding(findings)).toBe(false);
    expect(findings.map((finding) => finding.code)).toContain('ANONYMOUS_ACCESS');
  });

  it('does not flag an open proxy when every listener demands an identity', () => {
    const findings = detectSecurityFindings(
      createEmptyIr({
        authentication: {
          mode: 'REQUIRED',
          realm: 'Squid',
          providers: [
            {
              key: 'local',
              type: 'LOCAL',
              name: 'Local users',
              priority: 10,
              helper: { kind: 'NCSA', passwordFile: '/etc/squid/scp/local_users', children: 10 },
            },
          ],
          localGroupMembers: {},
        },
        defaultAccess: 'ALLOW',
        listeners: [authenticatedListener],
        rules: [allowAnyRule()],
      }),
    );
    expect(hasOpenProxyFinding(findings)).toBe(false);
  });

  it('warns about rules that can never match because no listener asks for an identity', () => {
    const findings = detectSecurityFindings(
      disabledAuthIr({
        defaultAccess: 'DENY',
        rules: [allowAnyRule({ identity: { kind: 'AUTHENTICATED' } })],
      }),
    );
    expect(findings.map((finding) => finding.code)).toContain('UNREACHABLE_IDENTITY_RULE');
  });

  it('flags a listener that demands an identity while no provider is enabled', () => {
    const findings = detectSecurityFindings(
      createEmptyIr({
        authentication: { mode: 'REQUIRED', realm: 'Squid', providers: [], localGroupMembers: {} },
        listeners: [{ ...authenticatedListener, address: '10.0.0.5' }],
      }),
    );
    expect(findings.map((finding) => finding.code)).toContain('NO_ENABLED_PROVIDER');
  });
});
