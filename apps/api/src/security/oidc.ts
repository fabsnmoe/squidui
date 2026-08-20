import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

/**
 * OpenID Connect, authorisation code flow with PKCE (ADR 0004).
 *
 * Dependency free on purpose, like the rest of this codebase: discovery and the
 * token exchange are plain HTTP, and an RS256 signature is verifiable with
 * node:crypto alone once the JWKS is fetched. A library would buy convenience
 * at the price of a supply chain in the component that decides who is an
 * administrator.
 *
 * The ID token is verified, never merely decoded. Decoding a token and reading
 * a claim out of it is not authentication - it is trusting whoever sent it.
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

/** Clock skew tolerated when checking `exp`. Providers and hosts drift. */
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_TTL_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;

const discoveryCache = new Map<string, { fetchedAt: number; document: OidcDiscovery }>();
const jwksCache = new Map<string, { fetchedAt: number; keys: JsonWebKey[] }>();

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSegment(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, 'base64');
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) {
    // The provider's own error text is what an operator needs; a status code
    // alone sends them guessing (the lesson from the agent's bare 403).
    throw new Error(`${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const normalised = issuer.replace(/\/+$/, '');
  const cached = discoveryCache.get(normalised);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.document;

  const document = await fetchJson<OidcDiscovery>(`${normalised}/.well-known/openid-configuration`);

  // A discovery document that names a different issuer is either a
  // misconfiguration or an attempt to have us trust the wrong authority.
  if (document.issuer.replace(/\/+$/, '') !== normalised) {
    throw new Error(
      `The provider at ${normalised} identifies itself as "${document.issuer}". Configure that value as the issuer instead.`,
    );
  }

  discoveryCache.set(normalised, { fetchedAt: Date.now(), document });
  return document;
}

async function jwksFor(jwksUri: string, forceRefresh = false): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.keys;

  const { keys } = await fetchJson<{ keys: JsonWebKey[] }>(jwksUri);
  jwksCache.set(jwksUri, { fetchedAt: Date.now(), keys });
  return keys;
}

/* -------------------------------------------------------------------------- */
/* PKCE                                                                        */
/* -------------------------------------------------------------------------- */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

export const randomToken = (): string => base64Url(randomBytes(32));

export function buildAuthorizationUrl(input: {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Token exchange and verification                                             */
/* -------------------------------------------------------------------------- */

export async function exchangeCode(input: {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ id_token: string; access_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  // A public client has no secret; a confidential one authenticates with it.
  if (input.clientSecret) body.set('client_secret', input.clientSecret);

  return fetchJson<{ id_token: string; access_token?: string }>(input.discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
}

const RSA_ALGORITHMS: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};

/**
 * Verifies signature, issuer, audience, expiry and nonce - in that order,
 * because a claim read out of an unverified token means nothing.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { discovery: OidcDiscovery; clientId: string; nonce: string },
): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('The provider returned a malformed ID token.');
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = JSON.parse(decodeSegment(headerSegment).toString('utf8')) as { alg?: string; kid?: string };
  const algorithm = RSA_ALGORITHMS[header.alg ?? ''];
  if (!algorithm) {
    // "none" and the HMAC family are refused deliberately: with a shared secret
    // an attacker who knows the client secret could mint an administrator.
    throw new Error(`Unsupported ID token algorithm "${header.alg}". Configure the provider to sign with RS256.`);
  }

  const signature = decodeSegment(signatureSegment);
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'utf8');

  const matches = async (refresh: boolean): Promise<boolean> => {
    const keys = await jwksFor(expected.discovery.jwks_uri, refresh);
    const candidates = header.kid ? keys.filter((key) => (key as { kid?: string }).kid === header.kid) : keys;
    return candidates.some((jwk) => {
      try {
        const key = createPublicKey({ key: jwk as never, format: 'jwk' });
        return verifySignature(algorithm, signed, key, signature);
      } catch {
        return false;
      }
    });
  };

  // Providers rotate signing keys. A miss is refetched once before it is
  // treated as a bad signature, otherwise every rotation locks everyone out
  // until the cache expires.
  if (!(await matches(false)) && !(await matches(true))) {
    throw new Error('The ID token signature does not match any key published by the provider.');
  }

  const claims = JSON.parse(decodeSegment(payloadSegment).toString('utf8')) as IdTokenClaims;

  if (claims.iss.replace(/\/+$/, '') !== expected.discovery.issuer.replace(/\/+$/, '')) {
    throw new Error('The ID token was issued by a different issuer than the one configured.');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) {
    throw new Error('The ID token was issued for a different client.');
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < Math.floor(Date.now() / 1000)) {
    throw new Error('The ID token has expired.');
  }
  // Without this check a token captured from another sign-in could be replayed.
  if (claims.nonce !== expected.nonce) {
    throw new Error('The ID token does not belong to this sign-in attempt.');
  }

  return claims;
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                      */
/* -------------------------------------------------------------------------- */

/** Reads a dotted path such as `realm_access.roles` out of the claim set. */
export function claimAt(claims: IdTokenClaims, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, segment) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined,
      claims,
    );
}

/**
 * Admission for one door. An empty claim name admits every authenticated user,
 * which is what a small installation wants and what the UI says it does.
 */
export function admits(claims: IdTokenClaims, claimPath: string | null, required: string | null): boolean {
  if (!claimPath || !required) return true;
  const value = claimAt(claims, claimPath);
  if (Array.isArray(value)) return value.some((entry) => String(entry) === required);
  if (value === undefined || value === null) return false;
  return String(value) === required;
}

/**
 * The username to use locally. Falls back through the usual claims rather than
 * failing, because a provider that omits `preferred_username` is common enough
 * and the subject is always present.
 */
export function usernameFrom(claims: IdTokenClaims, claimPath: string): string {
  const candidates = [claimAt(claims, claimPath), claims.preferred_username, claims.email, claims.sub];
  const found = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return String(found).trim();
}
