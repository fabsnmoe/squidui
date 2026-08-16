import { describe, expect, it } from 'vitest';
import {
  evaluate,
  matchesDestination,
  matchesDomain,
  matchesIdentity,
  matchesSchedule,
  matchesSource,
  type RequestIdentity,
} from './engine.js';
import {
  createEmptyIr,
  type ConfigurationIr,
  type IdentityMatcher,
  type PolicyRule,
} from './ir.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const GUEST_NETWORK = { id: 'net-guest', name: 'Guest network', cidrs: ['10.20.0.0/24'] };
const OFFICE_NETWORK = { id: 'net-office', name: 'Office network', cidrs: ['10.10.0.0/16'] };

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

function ir(overrides: Partial<ConfigurationIr> = {}): ConfigurationIr {
  return createEmptyIr(overrides);
}

const anonymous: RequestIdentity = { authenticated: false };
const alice: RequestIdentity = {
  authenticated: true,
  username: 'alice',
  providerKey: 'ldap-company',
  groups: [{ source: 'EXTERNAL', name: 'Developers', providerKey: 'ldap-company' }],
};
const serviceUser: RequestIdentity = {
  authenticated: true,
  username: 'service-api',
  providerKey: 'local',
  groups: [{ source: 'LOCAL', name: 'Services', providerKey: null }],
};

/* -------------------------------------------------------------------------- */
/* Identity matchers - one test per matcher (PLAN.md 9.3)                      */
/* -------------------------------------------------------------------------- */

describe('identity matcher ANY', () => {
  const matcher: IdentityMatcher = { kind: 'ANY' };

  it('matches authenticated and anonymous clients', () => {
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
    expect(matchesIdentity(matcher, anonymous, { authenticationDisabled: false })).toBe(true);
  });

  it('still matches when authentication is disabled', () => {
    expect(matchesIdentity(matcher, anonymous, { authenticationDisabled: true })).toBe(true);
  });
});

describe('identity matcher AUTHENTICATED', () => {
  const matcher: IdentityMatcher = { kind: 'AUTHENTICATED' };

  it('matches only authenticated clients', () => {
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
    expect(matchesIdentity(matcher, anonymous, { authenticationDisabled: false })).toBe(false);
  });

  it('never matches while authentication is disabled', () => {
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: true })).toBe(false);
  });
});

describe('identity matcher UNAUTHENTICATED', () => {
  const matcher: IdentityMatcher = { kind: 'UNAUTHENTICATED' };

  it('matches anonymous clients only', () => {
    expect(matchesIdentity(matcher, anonymous, { authenticationDisabled: false })).toBe(true);
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(false);
  });

  it('matches everyone while authentication is disabled', () => {
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: true })).toBe(true);
  });
});

describe('identity matcher USER', () => {
  it('matches the named user regardless of provider when none is pinned', () => {
    const matcher: IdentityMatcher = {
      kind: 'USER',
      users: [{ providerKey: null, username: 'alice' }],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
    expect(matchesIdentity(matcher, serviceUser, { authenticationDisabled: false })).toBe(false);
  });

  it('is case insensitive on the username', () => {
    const matcher: IdentityMatcher = {
      kind: 'USER',
      users: [{ providerKey: null, username: 'ALICE' }],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
  });

  it('respects a pinned provider', () => {
    const matcher: IdentityMatcher = {
      kind: 'USER',
      users: [{ providerKey: 'local', username: 'alice' }],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(false);
  });

  it('never matches an anonymous client', () => {
    const matcher: IdentityMatcher = {
      kind: 'USER',
      users: [{ providerKey: null, username: 'alice' }],
    };
    expect(matchesIdentity(matcher, anonymous, { authenticationDisabled: false })).toBe(false);
  });
});

describe('identity matcher GROUP', () => {
  it('matches a local group membership', () => {
    const matcher: IdentityMatcher = {
      kind: 'GROUP',
      groups: [{ source: 'LOCAL', name: 'Services', providerKey: null }],
    };
    expect(matchesIdentity(matcher, serviceUser, { authenticationDisabled: false })).toBe(true);
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(false);
  });

  it('matches an external group from the same provider', () => {
    const matcher: IdentityMatcher = {
      kind: 'GROUP',
      groups: [{ source: 'EXTERNAL', name: 'Developers', providerKey: 'ldap-company' }],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
  });

  it('does not match the same group name from a different provider', () => {
    const matcher: IdentityMatcher = {
      kind: 'GROUP',
      groups: [{ source: 'EXTERNAL', name: 'Developers', providerKey: 'ldap-lab' }],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(false);
  });

  it('matches through a logical group that unifies local and LDAP groups', () => {
    // PRODUCT.md section 18: the policy model must not depend on where a group
    // comes from.
    const matcher: IdentityMatcher = {
      kind: 'GROUP',
      groups: [
        {
          source: 'LOGICAL',
          name: 'Developer Access',
          providerKey: null,
          expandsTo: [
            { source: 'LOCAL', name: 'Developers', providerKey: null },
            { source: 'EXTERNAL', name: 'Developers', providerKey: 'ldap-company' },
          ],
        },
      ],
    };
    expect(matchesIdentity(matcher, alice, { authenticationDisabled: false })).toBe(true);
    const localDeveloper: RequestIdentity = {
      authenticated: true,
      username: 'dev-local',
      providerKey: 'local',
      groups: [{ source: 'LOCAL', name: 'Developers', providerKey: null }],
    };
    expect(matchesIdentity(matcher, localDeveloper, { authenticationDisabled: false })).toBe(true);
  });

  it('does not match an empty group list', () => {
    expect(
      matchesIdentity({ kind: 'GROUP', groups: [] }, alice, { authenticationDisabled: false }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Source, destination, schedule                                               */
/* -------------------------------------------------------------------------- */

describe('source matcher', () => {
  it('matches any source', () => {
    expect(matchesSource({ kind: 'ANY' }, '203.0.113.9')).toBe(true);
  });

  it('matches an IPv4 address inside a configured network', () => {
    const matcher = { kind: 'NETWORKS' as const, networks: [GUEST_NETWORK] };
    expect(matchesSource(matcher, '10.20.0.5')).toBe(true);
    expect(matchesSource(matcher, '10.21.0.5')).toBe(false);
  });

  it('matches IPv6 sources', () => {
    const matcher = {
      kind: 'NETWORKS' as const,
      networks: [{ id: 'n', name: 'v6', cidrs: ['2001:db8::/32'] }],
    };
    expect(matchesSource(matcher, '2001:db8::1')).toBe(true);
    expect(matchesSource(matcher, '2001:db9::1')).toBe(false);
  });

  it('does not match an unparseable source address', () => {
    expect(matchesSource({ kind: 'NETWORKS', networks: [GUEST_NETWORK] }, 'not-an-ip')).toBe(false);
  });
});

describe('destination matcher', () => {
  it('matches any destination', () => {
    expect(matchesDestination({ kind: 'ANY' }, 'example.com', 443)).toBe(true);
  });

  it('applies squid dstdomain semantics', () => {
    expect(matchesDomain('www.example.com', ['.example.com'])).toBe(true);
    expect(matchesDomain('example.com', ['.example.com'])).toBe(true);
    expect(matchesDomain('notexample.com', ['.example.com'])).toBe(false);
    expect(matchesDomain('example.com', ['example.com'])).toBe(true);
    expect(matchesDomain('www.example.com', ['example.com'])).toBe(false);
  });

  it('requires the port to match when ports are configured', () => {
    const matcher = { kind: 'SPECIFIC' as const, ports: [443] };
    expect(matchesDestination(matcher, 'example.com', 443)).toBe(true);
    expect(matchesDestination(matcher, 'example.com', 80)).toBe(false);
    expect(matchesDestination(matcher, 'example.com', null)).toBe(false);
  });

  it('matches destination networks', () => {
    const matcher = { kind: 'SPECIFIC' as const, cidrs: ['192.0.2.0/24'] };
    expect(matchesDestination(matcher, '192.0.2.7', 443)).toBe(true);
    expect(matchesDestination(matcher, '198.51.100.7', 443)).toBe(false);
  });
});

describe('schedule matcher', () => {
  it('always matches an ALWAYS schedule', () => {
    expect(matchesSchedule({ kind: 'ALWAYS' }, new Date('2026-08-16T03:00:00'))).toBe(true);
  });

  it('matches inside a weekday window', () => {
    // 2026-08-17 is a Monday.
    const schedule = {
      kind: 'WINDOW' as const,
      days: ['MON' as const],
      startMinutes: 8 * 60,
      endMinutes: 17 * 60,
    };
    expect(matchesSchedule(schedule, new Date('2026-08-17T09:00:00'))).toBe(true);
    expect(matchesSchedule(schedule, new Date('2026-08-17T18:00:00'))).toBe(false);
    expect(matchesSchedule(schedule, new Date('2026-08-18T09:00:00'))).toBe(false);
  });

  it('handles a window crossing midnight', () => {
    const schedule = {
      kind: 'WINDOW' as const,
      days: ['MON' as const],
      startMinutes: 22 * 60,
      endMinutes: 6 * 60,
    };
    expect(matchesSchedule(schedule, new Date('2026-08-17T23:30:00'))).toBe(true);
    expect(matchesSchedule(schedule, new Date('2026-08-17T02:00:00'))).toBe(true);
    expect(matchesSchedule(schedule, new Date('2026-08-17T12:00:00'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end evaluation - the acceptance scenarios of PRODUCT.md section 27   */
/* -------------------------------------------------------------------------- */

describe('scenario A - authentication disabled, allow any', () => {
  const configuration = ir({
    authentication: { mode: 'DISABLED', realm: 'Squid', providers: [], localGroupMembers: {} },
    defaultAccess: 'ALLOW',
    rules: [rule({ id: 'r1', position: 10, action: 'ALLOW' })],
  });

  it('lets an anonymous client through', () => {
    const result = evaluate(configuration, { sourceIp: '10.20.0.5', identity: anonymous });
    expect(result.decision).toBe('ALLOW');
    expect(result.matchedRule?.id).toBe('r1');
  });
});

describe('scenario B/C/D - authentication required', () => {
  const configuration = ir({
    authentication: {
      mode: 'REQUIRED',
      realm: 'Squid',
      providers: [],
      localGroupMembers: {},
    },
    defaultAccess: 'DENY',
    rules: [rule({ id: 'r1', position: 10, identity: { kind: 'AUTHENTICATED' } })],
  });

  it('challenges an anonymous client before evaluating any rule', () => {
    const result = evaluate(configuration, { sourceIp: '10.10.0.5', identity: anonymous });
    expect(result.decision).toBe('CHALLENGE');
    expect(result.trace).toHaveLength(0);
  });

  it('allows a local user and an LDAP user through the same rule', () => {
    expect(evaluate(configuration, { sourceIp: '10.10.0.5', identity: alice }).decision).toBe('ALLOW');
    expect(evaluate(configuration, { sourceIp: '10.10.0.5', identity: serviceUser }).decision).toBe(
      'ALLOW',
    );
  });
});

describe('scenario E - optional mode, employees and guests in parallel', () => {
  // PRODUCT.md section 7 example rule set.
  const configuration = ir({
    authentication: { mode: 'OPTIONAL', realm: 'Squid', providers: [], localGroupMembers: {} },
    defaultAccess: 'DENY',
    rules: [
      rule({
        id: 'r10',
        position: 10,
        name: 'Guests without credentials',
        source: { kind: 'NETWORKS', networks: [GUEST_NETWORK] },
        identity: { kind: 'UNAUTHENTICATED' },
        destination: { kind: 'SPECIFIC', ports: [80, 443] },
        action: 'ALLOW',
      }),
      rule({
        id: 'r20',
        position: 20,
        name: 'Authenticated employees',
        identity: { kind: 'AUTHENTICATED' },
        action: 'ALLOW',
      }),
      rule({ id: 'r30', position: 30, name: 'Deny everything else', action: 'DENY' }),
    ],
  });

  it('allows an authenticated employee anywhere', () => {
    const result = evaluate(configuration, { sourceIp: '10.10.0.5', identity: alice });
    expect(result.decision).toBe('ALLOW');
    expect(result.matchedRule?.id).toBe('r20');
  });

  it('allows an anonymous guest to reach the web', () => {
    const result = evaluate(configuration, {
      sourceIp: '10.20.0.5',
      identity: anonymous,
      destinationHost: 'example.com',
      destinationPort: 443,
    });
    expect(result.decision).toBe('ALLOW');
    expect(result.matchedRule?.id).toBe('r10');
  });

  it('denies an anonymous client from a network that is not the guest network', () => {
    const result = evaluate(configuration, {
      sourceIp: '10.10.0.5',
      identity: anonymous,
      destinationHost: 'example.com',
      destinationPort: 443,
    });
    expect(result.decision).toBe('DENY');
    expect(result.matchedRule?.id).toBe('r30');
  });

  it('denies an anonymous guest on a non-web port', () => {
    const result = evaluate(configuration, {
      sourceIp: '10.20.0.5',
      identity: anonymous,
      destinationHost: 'example.com',
      destinationPort: 22,
    });
    expect(result.decision).toBe('DENY');
  });
});

describe('rule ordering and defaults', () => {
  it('evaluates rules by position, first match wins', () => {
    const configuration = ir({
      defaultAccess: 'DENY',
      rules: [
        rule({ id: 'later', position: 20, action: 'ALLOW' }),
        rule({ id: 'earlier', position: 10, action: 'DENY' }),
      ],
    });
    const result = evaluate(configuration, { sourceIp: '10.0.0.1', identity: anonymous });
    expect(result.matchedRule?.id).toBe('earlier');
    expect(result.decision).toBe('DENY');
  });

  it('skips disabled rules and records why', () => {
    const configuration = ir({
      defaultAccess: 'ALLOW',
      rules: [rule({ id: 'off', position: 10, action: 'DENY', enabled: false })],
    });
    const result = evaluate(configuration, { sourceIp: '10.0.0.1', identity: anonymous });
    expect(result.decision).toBe('ALLOW');
    expect(result.trace[0]?.failedOn).toBe('DISABLED');
  });

  it('falls back to the default access policy when nothing matches', () => {
    const configuration = ir({
      defaultAccess: 'DENY',
      rules: [
        rule({
          id: 'office-only',
          position: 10,
          source: { kind: 'NETWORKS', networks: [OFFICE_NETWORK] },
        }),
      ],
    });
    const result = evaluate(configuration, { sourceIp: '192.0.2.1', identity: anonymous });
    expect(result.decision).toBe('DENY');
    expect(result.matchedRule).toBeNull();
    expect(result.trace[0]?.failedOn).toBe('SOURCE');
  });

  it('never matches an identity rule while authentication is disabled', () => {
    const configuration = ir({
      authentication: { mode: 'DISABLED', realm: 'Squid', providers: [], localGroupMembers: {} },
      defaultAccess: 'DENY',
      rules: [rule({ id: 'auth', position: 10, identity: { kind: 'AUTHENTICATED' } })],
    });
    const result = evaluate(configuration, { sourceIp: '10.0.0.1', identity: alice });
    expect(result.decision).toBe('DENY');
    expect(result.trace[0]?.failedOn).toBe('IDENTITY');
  });
});
