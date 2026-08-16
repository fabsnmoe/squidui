/**
 * Configuration intermediate representation.
 *
 * The IR is the contract between the product model (database entities) and any
 * Squid version adapter. It is self contained: everything a compiler or the
 * policy engine needs is embedded, so neither has to touch a database.
 */

import type { AuthenticationMode, AuthenticationProviderType, GroupSource } from '../auth/model.js';

export const IR_VERSION = '1.0.0';

export type PolicyAction = 'ALLOW' | 'DENY';

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** PRODUCT.md section 26 - the five matchers the IR must know. */
export const IDENTITY_MATCHER_KINDS = [
  'ANY',
  'AUTHENTICATED',
  'UNAUTHENTICATED',
  'USER',
  'GROUP',
] as const;
export type IdentityMatcherKind = (typeof IDENTITY_MATCHER_KINDS)[number];

export interface IdentityUserRef {
  /** Provider key the user belongs to, or `null` for "any provider". */
  providerKey: string | null;
  username: string;
}

export interface IdentityGroupRef {
  source: GroupSource;
  /** Stable identifier used for matching, e.g. `Developers` or a DN. */
  name: string;
  providerKey: string | null;
  /**
   * For LOGICAL groups: the concrete groups this expands to. The engine and
   * the compiler both work on the expansion, so logical groups never leak
   * into matching logic.
   */
  expandsTo?: IdentityGroupRef[];
}

export type IdentityMatcher =
  | { kind: 'ANY' }
  | { kind: 'AUTHENTICATED' }
  | { kind: 'UNAUTHENTICATED' }
  | { kind: 'USER'; users: IdentityUserRef[] }
  | { kind: 'GROUP'; groups: IdentityGroupRef[] };

/* -------------------------------------------------------------------------- */
/* Source, destination, schedule                                               */
/* -------------------------------------------------------------------------- */

export interface NamedNetwork {
  id: string;
  name: string;
  cidrs: string[];
}

export type SourceMatcher =
  | { kind: 'ANY' }
  | { kind: 'NETWORKS'; networks: NamedNetwork[] };

export interface DestinationMatcher {
  kind: 'ANY' | 'SPECIFIC';
  /** Domain suffixes, Squid `dstdomain` semantics (`.example.com`). */
  domains?: string[];
  /** Destination networks, Squid `dst` semantics. */
  cidrs?: string[];
  /** Destination ports, Squid `port` semantics. */
  ports?: number[];
}

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type ScheduleMatcher =
  | { kind: 'ALWAYS' }
  | {
      kind: 'WINDOW';
      days: Weekday[];
      /** Minutes since midnight, local time of the proxy node. */
      startMinutes: number;
      endMinutes: number;
    };

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export interface PolicyRule {
  id: string;
  /** Ordering key. Lower positions are evaluated first. */
  position: number;
  name: string;
  description?: string | null;
  enabled: boolean;
  action: PolicyAction;
  source: SourceMatcher;
  identity: IdentityMatcher;
  destination: DestinationMatcher;
  schedule: ScheduleMatcher;
}

/* -------------------------------------------------------------------------- */
/* Listeners and providers                                                     */
/* -------------------------------------------------------------------------- */

export type ListenerMode = 'FORWARD' | 'INTERCEPT';

export interface Listener {
  id: string;
  name: string;
  /** Bind address, e.g. `0.0.0.0`, `::`, `10.0.0.5`. */
  address: string;
  port: number;
  mode: ListenerMode;
  enabled: boolean;
}

export interface IrAuthenticationProvider {
  key: string;
  type: AuthenticationProviderType;
  name: string;
  priority: number;
  /**
   * Provider specific data the compiler needs, without any secret. LDAP bind
   * passwords are referenced by secret name, never inlined.
   */
  helper: LocalHelperSpec | LdapHelperSpec;
}

export interface LocalHelperSpec {
  kind: 'NCSA';
  /** Path of the generated password file on the proxy node. */
  passwordFile: string;
  children: number;
}

export interface LdapHelperSpec {
  kind: 'LDAP';
  uri: string;
  baseDn: string;
  userFilter: string;
  bindDn: string | null;
  /** Name of the secret in the node's secret store, never the value. */
  bindPasswordRef: string | null;
  useTls: boolean;
  groupBaseDn: string | null;
  groupFilter: string | null;
  children: number;
}

/* -------------------------------------------------------------------------- */
/* Root document                                                               */
/* -------------------------------------------------------------------------- */

export interface AuthenticationIr {
  mode: AuthenticationMode;
  realm: string;
  /** Enabled providers only, already ordered by priority. */
  providers: IrAuthenticationProvider[];
  /**
   * Local group memberships, expanded at compile time so that a `GROUP`
   * matcher against a local group becomes a concrete user list.
   */
  localGroupMembers: Record<string, string[]>;
}

export interface ConfigurationIr {
  irVersion: string;
  generatedAt: string;
  authentication: AuthenticationIr;
  defaultAccess: PolicyAction;
  listeners: Listener[];
  rules: PolicyRule[];
}

export function createEmptyIr(overrides: Partial<ConfigurationIr> = {}): ConfigurationIr {
  return {
    irVersion: IR_VERSION,
    generatedAt: new Date(0).toISOString(),
    authentication: {
      mode: 'DISABLED',
      realm: 'Squid Proxy',
      providers: [],
      localGroupMembers: {},
    },
    defaultAccess: 'DENY',
    listeners: [],
    rules: [],
    ...overrides,
  };
}

/** Canonical key used to compare group references across sources. */
export function groupKey(ref: IdentityGroupRef): string {
  const prefix =
    ref.source === 'LOCAL' ? 'LOCAL' : ref.source === 'LOGICAL' ? 'LOGICAL' : (ref.providerKey ?? 'EXTERNAL').toUpperCase();
  return `${prefix}:${ref.name}`;
}

/** Flattens logical groups into the concrete groups they contain. */
export function expandGroupRefs(refs: readonly IdentityGroupRef[]): IdentityGroupRef[] {
  const out: IdentityGroupRef[] = [];
  const seen = new Set<string>();
  const visit = (ref: IdentityGroupRef, depth: number): void => {
    if (depth > 8) return; // defensive: a cycle in logical group definitions
    if (ref.source === 'LOGICAL') {
      for (const child of ref.expandsTo ?? []) visit(child, depth + 1);
      return;
    }
    const key = groupKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const ref of refs) visit(ref, 0);
  return out;
}

export function sortRules(rules: readonly PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
