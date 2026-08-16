/**
 * Open proxy detection (PRODUCT.md section 5, PLAN.md 9.19).
 *
 * The product must not prevent a deliberate open proxy - an administrator may
 * legitimately want one inside a trusted lab network. It must prevent an
 * *accidental* one. So this module only produces findings; the decision to
 * proceed stays with the operator, and the acknowledgement is audited.
 */

import { cidrSize, isPrivateCidr, isUnspecifiedRange, parseCidr, parseIp } from '../net/ip.js';
import type { ConfigurationIr, Listener, PolicyRule } from './ir.js';

export type FindingSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface SecurityFinding {
  code: string;
  severity: FindingSeverity;
  title: string;
  /** Operator facing explanation, shown verbatim in the UI. */
  detail: string;
  evidence: string[];
}

export const OPEN_PROXY_WARNING_TEXT =
  'This configuration may create an unauthenticated open proxy.\n\n' +
  'Clients from the configured source networks can use this proxy without ' +
  'credentials.\n\n' +
  'Verify listener addresses, firewall rules and allowed source networks ' +
  'before deployment.';

/** A listener that is not bound to a loopback or private address. */
function listenerIsWidelyReachable(listener: Listener): boolean {
  if (!listener.enabled) return false;
  const address = parseIp(listener.address);
  if (!address) return true; // unparseable / hostname: assume the worst
  if (address.value === 0n) return true; // 0.0.0.0 or ::
  const cidr = parseCidr(listener.address);
  if (!cidr) return true;
  return !isPrivateCidr(cidr);
}

/** True when the rule lets an anonymous client reach anything. */
function isAnonymousAllowAnything(rule: PolicyRule): boolean {
  if (!rule.enabled || rule.action !== 'ALLOW') return false;
  const identityAllowsAnonymous =
    rule.identity.kind === 'ANY' || rule.identity.kind === 'UNAUTHENTICATED';
  if (!identityAllowsAnonymous) return false;
  if (rule.destination.kind !== 'ANY') return false;
  return rule.schedule.kind === 'ALWAYS';
}

function widestSourceDescription(rule: PolicyRule): { description: string; wide: boolean } {
  if (rule.source.kind === 'ANY') {
    return { description: 'any source address', wide: true };
  }
  let wide = false;
  const parts: string[] = [];
  for (const network of rule.source.networks) {
    for (const text of network.cidrs) {
      const cidr = parseCidr(text);
      if (!cidr) continue;
      parts.push(`${network.name} (${cidr.text})`);
      if (isUnspecifiedRange(cidr)) wide = true;
      else if (!isPrivateCidr(cidr)) wide = true;
      // A public /8 or wider is treated as internet facing as well.
      else if (cidrSize(cidr) > 1n << 24n) wide = true;
    }
  }
  return { description: parts.join(', ') || 'no resolvable network', wide };
}

export function detectSecurityFindings(ir: ConfigurationIr): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const authDisabled = ir.authentication.mode === 'DISABLED';

  const wideListeners = ir.listeners.filter(listenerIsWidelyReachable);
  const listenerEvidence = wideListeners.map(
    (listener) => `${listener.name}: ${listener.address}:${listener.port} (${listener.mode})`,
  );

  if (authDisabled) {
    const anonymousRules = ir.rules.filter(isAnonymousAllowAnything);
    const openRules = anonymousRules.filter((rule) => widestSourceDescription(rule).wide);
    const defaultAllows = ir.defaultAccess === 'ALLOW';

    if (defaultAllows || openRules.length > 0) {
      const evidence: string[] = ['Authentication mode: DISABLED'];
      if (defaultAllows) evidence.push('Default access: ALLOW');
      for (const rule of openRules) {
        evidence.push(
          `Rule ${rule.position} "${rule.name}": ALLOW from ${widestSourceDescription(rule).description} to any destination`,
        );
      }
      evidence.push(
        wideListeners.length > 0
          ? `Listeners reachable beyond private networks: ${listenerEvidence.join(', ')}`
          : 'All listeners are bound to private or loopback addresses',
      );

      findings.push({
        code: 'OPEN_PROXY',
        severity: wideListeners.length > 0 ? 'CRITICAL' : 'WARNING',
        title: 'This configuration may create an unauthenticated open proxy',
        detail: OPEN_PROXY_WARNING_TEXT,
        evidence,
      });
    } else if (anonymousRules.length > 0) {
      findings.push({
        code: 'ANONYMOUS_ACCESS',
        severity: 'INFO',
        title: 'Anonymous clients may use this proxy',
        detail:
          'Authentication is disabled and rules allow access without credentials. ' +
          'Access is limited to the configured private source networks.',
        evidence: [
          'Authentication mode: DISABLED',
          ...anonymousRules.map(
            (rule) => `Rule ${rule.position} "${rule.name}" allows ${widestSourceDescription(rule).description}`,
          ),
        ],
      });
    }
  }

  // Rules that can never match, because they need an identity that will never
  // exist in the current mode. Silent dead rules are a common source of
  // "why is my policy not working".
  if (authDisabled) {
    const deadRules = ir.rules.filter(
      (rule) =>
        rule.enabled &&
        (rule.identity.kind === 'AUTHENTICATED' ||
          rule.identity.kind === 'USER' ||
          rule.identity.kind === 'GROUP'),
    );
    if (deadRules.length > 0) {
      findings.push({
        code: 'UNREACHABLE_IDENTITY_RULE',
        severity: 'WARNING',
        title: 'Rules require an identity while authentication is disabled',
        detail:
          'These rules can never match: with authentication disabled Squid never learns a user ' +
          'identity. Either switch the mode to OPTIONAL or REQUIRED, or change the rules to ' +
          'match on source networks instead.',
        evidence: deadRules.map((rule) => `Rule ${rule.position} "${rule.name}" (${rule.identity.kind})`),
      });
    }
  }

  if (ir.authentication.mode !== 'DISABLED' && ir.authentication.providers.length === 0) {
    findings.push({
      code: 'NO_ENABLED_PROVIDER',
      severity: 'CRITICAL',
      title: 'Authentication is enabled but no provider is active',
      detail:
        'No authentication provider is enabled, so no client can authenticate. In REQUIRED mode ' +
        'this denies every request.',
      evidence: [`Authentication mode: ${ir.authentication.mode}`, 'Enabled providers: none'],
    });
  }

  return findings;
}

/** Convenience for the UI: is there an open proxy finding? */
export function hasOpenProxyFinding(findings: readonly SecurityFinding[]): boolean {
  return findings.some((finding) => finding.code === 'OPEN_PROXY');
}
