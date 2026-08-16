/**
 * Access profile: what a specific proxy identity may reach.
 *
 * This powers the self-service portal. It reuses the identity matcher of the
 * policy engine, so what a user is told matches what the engine decides -
 * there is no second implementation that can drift.
 */

import { matchesIdentity, type RequestIdentity } from './engine.js';
import {
  expandGroupRefs,
  sortRules,
  type ConfigurationIr,
  type DestinationMatcher,
  type PolicyRule,
  type ScheduleMatcher,
  type SourceMatcher,
  type Weekday,
} from './ir.js';

export interface AccessProfileEntry {
  ruleId: string;
  position: number;
  name: string;
  description: string | null;
  action: 'ALLOW' | 'DENY';
  source: string;
  destination: string;
  schedule: string;
  identity: string;
  /** One sentence in plain language, ready to render. */
  summary: string;
  /** True when the rule applies regardless of where the client connects from. */
  anySource: boolean;
}

export interface AccessProfile {
  mode: ConfigurationIr['authentication']['mode'];
  defaultAccess: 'ALLOW' | 'DENY';
  entries: AccessProfileEntry[];
  /** Rules that exist but can never apply to this identity. */
  notApplicable: number;
  notes: string[];
}

const DAY_NAMES: Record<Weekday, string> = {
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
};

function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.trunc(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

export function describeSource(matcher: SourceMatcher): string {
  if (matcher.kind === 'ANY') return 'any network';
  const names = matcher.networks.map((network) => network.name);
  if (names.length === 0) return 'no network';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] as string}`;
}

export function describeDestination(matcher: DestinationMatcher): string {
  if (matcher.kind === 'ANY') return 'any destination';
  const parts: string[] = [];
  const domains = matcher.domains?.filter(Boolean) ?? [];
  const cidrs = matcher.cidrs?.filter(Boolean) ?? [];
  const ports = matcher.ports ?? [];
  if (domains.length > 0) parts.push(domains.join(', '));
  if (cidrs.length > 0) parts.push(cidrs.join(', '));
  if (parts.length === 0 && ports.length === 0) return 'any destination';
  const target = parts.length > 0 ? parts.join(' and ') : 'any destination';
  return ports.length > 0 ? `${target} on port ${ports.join(', ')}` : target;
}

export function describeSchedule(matcher: ScheduleMatcher): string {
  if (matcher.kind === 'ALWAYS') return 'at any time';
  const days = matcher.days.map((day) => DAY_NAMES[day]).join(', ');
  return `${days} between ${formatMinutes(matcher.startMinutes)} and ${formatMinutes(matcher.endMinutes)}`;
}

export function describeIdentity(rule: PolicyRule): string {
  switch (rule.identity.kind) {
    case 'ANY':
      return 'everyone';
    case 'AUTHENTICATED':
      return 'any signed-in user';
    case 'UNAUTHENTICATED':
      return 'clients without credentials';
    case 'USER':
      return `the users ${rule.identity.users.map((user) => user.username).join(', ')}`;
    case 'GROUP': {
      const names = expandGroupRefs(rule.identity.groups).map((group) => group.name);
      return names.length > 0 ? `members of ${names.join(', ')}` : 'an empty group';
    }
  }
}

function summarise(rule: PolicyRule): string {
  const verb = rule.action === 'ALLOW' ? 'may reach' : 'are blocked from';
  const source = rule.source.kind === 'ANY' ? '' : ` when connecting from ${describeSource(rule.source)}`;
  const schedule = rule.schedule.kind === 'ALWAYS' ? '' : ` ${describeSchedule(rule.schedule)}`;
  return `You ${verb} ${describeDestination(rule.destination)}${source}${schedule}.`;
}

/**
 * Builds the profile for one identity.
 *
 * A rule is included when its identity condition can match this user. Source,
 * destination and schedule are reported rather than evaluated, because the
 * portal does not know which network the user will connect from.
 */
export function buildAccessProfile(ir: ConfigurationIr, identity: RequestIdentity): AccessProfile {
  const authenticationDisabled = ir.authentication.mode === 'DISABLED';
  const entries: AccessProfileEntry[] = [];
  let notApplicable = 0;

  for (const rule of sortRules(ir.rules)) {
    if (!rule.enabled) {
      notApplicable += 1;
      continue;
    }
    if (!matchesIdentity(rule.identity, identity, { authenticationDisabled })) {
      notApplicable += 1;
      continue;
    }
    entries.push({
      ruleId: rule.id,
      position: rule.position,
      name: rule.name,
      description: rule.description ?? null,
      action: rule.action,
      source: describeSource(rule.source),
      destination: describeDestination(rule.destination),
      schedule: describeSchedule(rule.schedule),
      identity: describeIdentity(rule),
      summary: summarise(rule),
      anySource: rule.source.kind === 'ANY',
    });
  }

  const notes: string[] = [];
  notes.push('Rules are evaluated from top to bottom; the first one that matches decides.');
  if (entries.some((entry) => !entry.anySource)) {
    notes.push('Entries limited to a network only apply when you connect from that network.');
  }
  notes.push(
    ir.defaultAccess === 'ALLOW'
      ? 'Anything not covered above is allowed by the default access policy.'
      : 'Anything not covered above is blocked by the default access policy.',
  );
  if (authenticationDisabled) {
    notes.push(
      'Proxy authentication is currently disabled, so the proxy does not identify you and rules that require an identity never apply.',
    );
  }

  return { mode: ir.authentication.mode, defaultAccess: ir.defaultAccess, entries, notApplicable, notes };
}
