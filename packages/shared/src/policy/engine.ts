/**
 * Policy evaluation engine.
 *
 * Pure and deterministic: same IR + same request => same decision. It is the
 * reference implementation of the product semantics and the thing the Squid
 * compiler must stay faithful to. The UI uses it as a rule simulator.
 */

import { parseIp, ipInAnyCidr } from '../net/ip.js';
import {
  expandGroupRefs,
  groupKey,
  sortRules,
  type ConfigurationIr,
  type DestinationMatcher,
  type IdentityGroupRef,
  type IdentityMatcher,
  type PolicyRule,
  type ScheduleMatcher,
  type SourceMatcher,
  type Weekday,
} from './ir.js';

export type Decision = 'ALLOW' | 'DENY' | 'CHALLENGE';

/** Identity of the client as far as the proxy knows it at evaluation time. */
export interface RequestIdentity {
  authenticated: boolean;
  username?: string | null;
  providerKey?: string | null;
  /** Groups already resolved by the authenticating provider. */
  groups?: IdentityGroupRef[];
}

export interface EvaluationRequest {
  sourceIp: string;
  identity: RequestIdentity;
  destinationHost?: string | null;
  destinationPort?: number | null;
  /** Evaluation time; used for schedule matchers. Defaults to `new Date()`. */
  at?: Date;
}

export interface RuleTraceEntry {
  ruleId: string;
  ruleName: string;
  position: number;
  matched: boolean;
  /** Which component rejected the rule, when it did not match. */
  failedOn?: 'DISABLED' | 'SOURCE' | 'IDENTITY' | 'DESTINATION' | 'SCHEDULE';
  detail: string;
}

export interface EvaluationResult {
  decision: Decision;
  matchedRule: { id: string; name: string; position: number } | null;
  reason: string;
  trace: RuleTraceEntry[];
}

/** `Date.getDay()` is 0 = Sunday. */
const WEEKDAY_BY_INDEX: readonly Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/* -------------------------------------------------------------------------- */
/* Component matchers                                                          */
/* -------------------------------------------------------------------------- */

export function matchesSource(matcher: SourceMatcher, sourceIp: string): boolean {
  if (matcher.kind === 'ANY') return true;
  const address = parseIp(sourceIp);
  if (!address) return false;
  for (const network of matcher.networks) {
    if (ipInAnyCidr(address, network.cidrs)) return true;
  }
  return false;
}

/**
 * Identity matching (PRODUCT.md section 19, PLAN.md 9.3).
 *
 * `effectiveAuthenticated` is false whenever the global mode is DISABLED, no
 * matter what the caller claims - with authentication switched off Squid never
 * learns an identity, so a rule requiring one must not match.
 */
export function matchesIdentity(
  matcher: IdentityMatcher,
  identity: RequestIdentity,
  options: { authenticationDisabled: boolean },
): boolean {
  const authenticated = options.authenticationDisabled ? false : identity.authenticated;

  switch (matcher.kind) {
    case 'ANY':
      return true;

    case 'AUTHENTICATED':
      return authenticated;

    case 'UNAUTHENTICATED':
      return !authenticated;

    case 'USER': {
      if (!authenticated) return false;
      const username = identity.username?.toLowerCase();
      if (!username) return false;
      return matcher.users.some((ref) => {
        if (ref.username.toLowerCase() !== username) return false;
        if (ref.providerKey === null) return true;
        return ref.providerKey === identity.providerKey;
      });
    }

    case 'GROUP': {
      if (!authenticated) return false;
      const wanted = new Set(expandGroupRefs(matcher.groups).map(groupKey));
      if (wanted.size === 0) return false;
      for (const held of identity.groups ?? []) {
        if (wanted.has(groupKey(held))) return true;
      }
      return false;
    }
  }
}

export function matchesDestination(
  matcher: DestinationMatcher,
  host: string | null | undefined,
  port: number | null | undefined,
): boolean {
  if (matcher.kind === 'ANY') return true;

  const { domains, cidrs, ports } = matcher;

  if (ports && ports.length > 0) {
    if (port === null || port === undefined) return false;
    if (!ports.includes(port)) return false;
  }

  const hasHostConstraint = (domains?.length ?? 0) > 0 || (cidrs?.length ?? 0) > 0;
  if (!hasHostConstraint) return true;
  if (!host) return false;

  if (domains && domains.length > 0 && matchesDomain(host, domains)) return true;

  if (cidrs && cidrs.length > 0) {
    const address = parseIp(host);
    if (address && ipInAnyCidr(address, cidrs)) return true;
  }

  return false;
}

/** Squid `dstdomain` semantics: a leading dot also matches subdomains. */
export function matchesDomain(host: string, domains: readonly string[]): boolean {
  const target = host.toLowerCase().replace(/\.$/, '');
  for (const raw of domains) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry.startsWith('.')) {
      const bare = entry.slice(1);
      if (target === bare || target.endsWith(entry)) return true;
    } else if (target === entry) {
      return true;
    }
  }
  return false;
}

export function matchesSchedule(matcher: ScheduleMatcher, at: Date): boolean {
  if (matcher.kind === 'ALWAYS') return true;
  const day = WEEKDAY_BY_INDEX[at.getDay()];
  if (!day || !matcher.days.includes(day)) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  if (matcher.startMinutes <= matcher.endMinutes) {
    return minutes >= matcher.startMinutes && minutes < matcher.endMinutes;
  }
  // Window crossing midnight, e.g. 22:00-06:00.
  return minutes >= matcher.startMinutes || minutes < matcher.endMinutes;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

export function evaluate(ir: ConfigurationIr, request: EvaluationRequest): EvaluationResult {
  const at = request.at ?? new Date();
  const mode = ir.authentication.mode;
  const authenticationDisabled = mode === 'DISABLED';
  const trace: RuleTraceEntry[] = [];

  // Required mode: an anonymous client is challenged before any rule runs.
  // Rules never get the chance to allow an unidentified client through
  // (PRODUCT.md section 6).
  if (mode === 'REQUIRED' && !request.identity.authenticated) {
    return {
      decision: 'CHALLENGE',
      matchedRule: null,
      reason:
        'Authentication is required and the client did not present credentials. Squid answers with a proxy authentication request.',
      trace,
    };
  }

  for (const rule of sortRules(ir.rules)) {
    const entry = evaluateRule(rule, request, at, authenticationDisabled);
    trace.push(entry);
    if (entry.matched) {
      return {
        decision: rule.action,
        matchedRule: { id: rule.id, name: rule.name, position: rule.position },
        reason: `Rule ${rule.position} "${rule.name}" matched and evaluates to ${rule.action}.`,
        trace,
      };
    }
  }

  return {
    decision: ir.defaultAccess,
    matchedRule: null,
    reason: `No rule matched. The default access policy is ${ir.defaultAccess}.`,
    trace,
  };
}

function evaluateRule(
  rule: PolicyRule,
  request: EvaluationRequest,
  at: Date,
  authenticationDisabled: boolean,
): RuleTraceEntry {
  const base = { ruleId: rule.id, ruleName: rule.name, position: rule.position };

  if (!rule.enabled) {
    return { ...base, matched: false, failedOn: 'DISABLED', detail: 'Rule is disabled.' };
  }
  if (!matchesSource(rule.source, request.sourceIp)) {
    return {
      ...base,
      matched: false,
      failedOn: 'SOURCE',
      detail: `Source ${request.sourceIp} is not covered by the rule's source networks.`,
    };
  }
  if (!matchesIdentity(rule.identity, request.identity, { authenticationDisabled })) {
    return {
      ...base,
      matched: false,
      failedOn: 'IDENTITY',
      detail: describeIdentityMismatch(rule.identity, request.identity, authenticationDisabled),
    };
  }
  if (!matchesDestination(rule.destination, request.destinationHost, request.destinationPort)) {
    return {
      ...base,
      matched: false,
      failedOn: 'DESTINATION',
      detail: 'Destination does not match the rule.',
    };
  }
  if (!matchesSchedule(rule.schedule, at)) {
    return {
      ...base,
      matched: false,
      failedOn: 'SCHEDULE',
      detail: 'Outside the rule schedule.',
    };
  }
  return { ...base, matched: true, detail: `All conditions matched, action ${rule.action}.` };
}

function describeIdentityMismatch(
  matcher: IdentityMatcher,
  identity: RequestIdentity,
  authenticationDisabled: boolean,
): string {
  if (authenticationDisabled && matcher.kind !== 'ANY' && matcher.kind !== 'UNAUTHENTICATED') {
    return 'Authentication is disabled, so no client can ever satisfy this identity condition.';
  }
  switch (matcher.kind) {
    case 'AUTHENTICATED':
      return 'Client is not authenticated.';
    case 'UNAUTHENTICATED':
      return `Client is authenticated as ${identity.username ?? 'unknown'}.`;
    case 'USER':
      return `User ${identity.username ?? 'unauthenticated'} is not in the rule's user list.`;
    case 'GROUP':
      return `User ${identity.username ?? 'unauthenticated'} is not a member of the rule's groups.`;
    default:
      return 'Identity condition did not match.';
  }
}
