import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT implementation.
 *
 * Two audiences share the signing key but never each other's routes:
 *
 *   control-plane  operators of the web UI and the API (RBAC applies)
 *   proxy-portal   proxy users in the self-service portal (no RBAC at all)
 *
 * The audience is verified on every request, so a portal token can never be
 * replayed against a control plane endpoint even though both are signed by the
 * same secret (PRODUCT.md section 1 - the identity planes stay separate).
 */

export const AUDIENCES = ['control-plane', 'proxy-portal'] as const;
export type TokenAudience = (typeof AUDIENCES)[number];

interface BaseClaims {
  sub: string;
  aud: TokenAudience;
  iat: number;
  exp: number;
}

export interface SessionClaims extends BaseClaims {
  aud: 'control-plane';
  username: string;
  permissions: string[];
}

export interface PortalClaims extends BaseClaims {
  aud: 'proxy-portal';
  username: string;
  /** Which authentication provider accepted this user. */
  providerKey: string;
  /** Group names as resolved at sign-in time. */
  groups: string[];
}

export type AnyClaims = SessionClaims | PortalClaims;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, 'base64');
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

export function issueToken<T extends AnyClaims>(
  claims: Omit<T, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
): { token: string; expiresAt: Date } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, secret);
  return { token: `${header}.${body}.${signature}`, expiresAt: new Date(payload.exp * 1000) };
}

export type TokenVerification<T extends AnyClaims> =
  | { valid: true; claims: T }
  | { valid: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'WRONG_AUDIENCE' };

export function verifyToken<T extends AnyClaims>(
  token: string,
  secret: string,
  expectedAudience: T['aud'],
): TokenVerification<T> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'MALFORMED' };
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  let claims: T;
  try {
    const decodedHeader = JSON.parse(base64UrlDecode(header).toString('utf8')) as { alg?: string };
    // Reject "alg": "none" and algorithm confusion outright.
    if (decodedHeader.alg !== 'HS256') return { valid: false, reason: 'MALFORMED' };
    claims = JSON.parse(base64UrlDecode(body).toString('utf8')) as T;
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }

  if (typeof claims.exp !== 'number' || typeof claims.sub !== 'string') {
    return { valid: false, reason: 'MALFORMED' };
  }
  // A token without an audience predates this check and is not trusted either.
  if (claims.aud !== expectedAudience) return { valid: false, reason: 'WRONG_AUDIENCE' };
  if (claims.exp * 1000 <= Date.now()) return { valid: false, reason: 'EXPIRED' };

  return { valid: true, claims };
}
