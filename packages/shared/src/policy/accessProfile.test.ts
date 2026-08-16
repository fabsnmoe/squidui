import { describe, expect, it } from 'vitest';
import { buildAccessProfile, describeDestination, describeSchedule, describeSource } from './accessProfile.js';
import { createEmptyIr, type ConfigurationIr, type PolicyRule } from './ir.js';
import type { RequestIdentity } from './engine.js';

const GUEST = { id: 'net-guest', name: 'Guest network', cidrs: ['10.20.0.0/24'] };

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

const developer: RequestIdentity = {
  authenticated: true,
  username: 'alice',
  providerKey: 'local',
  groups: [{ source: 'LOCAL', name: 'Developers', providerKey: null }],
};

function ir(overrides: Partial<ConfigurationIr> = {}): ConfigurationIr {
  return createEmptyIr({
    authentication: { mode: 'REQUIRED', realm: 'Squid', providers: [], localGroupMembers: {} },
    ...overrides,
  });
}

describe('descriptions', () => {
  it('names source networks', () => {
    expect(describeSource({ kind: 'ANY' })).toBe('any network');
    expect(describeSource({ kind: 'NETWORKS', networks: [GUEST] })).toBe('Guest network');
    expect(
      describeSource({ kind: 'NETWORKS', networks: [GUEST, { id: 'b', name: 'Lab', cidrs: [] }] }),
    ).toBe('Guest network or Lab');
  });

  it('describes destinations including ports', () => {
    expect(describeDestination({ kind: 'ANY' })).toBe('any destination');
    expect(describeDestination({ kind: 'SPECIFIC', domains: ['.example.com'], ports: [443] })).toBe(
      '.example.com on port 443',
    );
    expect(describeDestination({ kind: 'SPECIFIC', ports: [80, 443] })).toBe('any destination on port 80, 443');
  });

  it('describes schedules', () => {
    expect(describeSchedule({ kind: 'ALWAYS' })).toBe('at any time');
    expect(
      describeSchedule({ kind: 'WINDOW', days: ['MON', 'FRI'], startMinutes: 8 * 60, endMinutes: 17 * 60 + 30 }),
    ).toBe('Mon, Fri between 08:00 and 17:30');
  });
});

describe('access profile', () => {
  it('includes rules the identity can match and excludes the rest', () => {
    const profile = buildAccessProfile(
      ir({
        defaultAccess: 'DENY',
        rules: [
          rule({
            id: 'r10',
            position: 10,
            name: 'Developer services',
            identity: { kind: 'GROUP', groups: [{ source: 'LOCAL', name: 'Developers', providerKey: null }] },
            destination: { kind: 'SPECIFIC', domains: ['.dev.example'] },
          }),
          rule({
            id: 'r20',
            position: 20,
            name: 'Guests only',
            identity: { kind: 'UNAUTHENTICATED' },
          }),
          rule({
            id: 'r30',
            position: 30,
            name: 'Other group',
            identity: { kind: 'GROUP', groups: [{ source: 'LOCAL', name: 'Finance', providerKey: null }] },
          }),
        ],
      }),
      developer,
    );

    expect(profile.entries.map((entry) => entry.ruleId)).toEqual(['r10']);
    expect(profile.notApplicable).toBe(2);
    expect(profile.entries[0]?.summary).toBe('You may reach .dev.example.');
  });

  it('reports deny rules too, because knowing what is blocked matters', () => {
    const profile = buildAccessProfile(
      ir({
        rules: [
          rule({
            id: 'r10',
            position: 10,
            name: 'No social media',
            action: 'DENY',
            identity: { kind: 'AUTHENTICATED' },
            destination: { kind: 'SPECIFIC', domains: ['.social.example'] },
          }),
        ],
      }),
      developer,
    );
    expect(profile.entries).toHaveLength(1);
    expect(profile.entries[0]?.action).toBe('DENY');
    expect(profile.entries[0]?.summary).toBe('You are blocked from .social.example.');
  });

  it('mentions the source network when a rule is limited to one', () => {
    const profile = buildAccessProfile(
      ir({
        rules: [rule({ id: 'r10', position: 10, source: { kind: 'NETWORKS', networks: [GUEST] } })],
      }),
      developer,
    );
    expect(profile.entries[0]?.anySource).toBe(false);
    expect(profile.entries[0]?.summary).toContain('when connecting from Guest network');
    expect(profile.notes.some((note) => note.includes('only apply when you connect'))).toBe(true);
  });

  it('skips disabled rules', () => {
    const profile = buildAccessProfile(
      ir({ rules: [rule({ id: 'r10', position: 10, enabled: false })] }),
      developer,
    );
    expect(profile.entries).toHaveLength(0);
    expect(profile.notApplicable).toBe(1);
  });

  it('explains that identity rules do not apply while authentication is disabled', () => {
    const profile = buildAccessProfile(
      ir({
        authentication: { mode: 'DISABLED', realm: 'Squid', providers: [], localGroupMembers: {} },
        rules: [rule({ id: 'r10', position: 10, identity: { kind: 'AUTHENTICATED' } })],
      }),
      developer,
    );
    expect(profile.entries).toHaveLength(0);
    expect(profile.notes.some((note) => note.includes('does not identify you'))).toBe(true);
  });

  it('states the default access policy', () => {
    const allow = buildAccessProfile(ir({ defaultAccess: 'ALLOW' }), developer);
    expect(allow.notes.some((note) => note.includes('allowed by the default access policy'))).toBe(true);
    const deny = buildAccessProfile(ir({ defaultAccess: 'DENY' }), developer);
    expect(deny.notes.some((note) => note.includes('blocked by the default access policy'))).toBe(true);
  });
});
