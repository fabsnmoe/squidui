import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactAuditPayload, REDACTED } from '@scp/shared';
import { decryptSecret, encryptSecret, SecretDecryptionError } from './secrets.js';
import { issueToken, verifyToken, type PortalClaims, type SessionClaims } from './jwt.js';
import { RateLimiter } from './rateLimit.js';
import { escapeLdapFilterValue, renderFilter } from '../providers/ldap.js';

describe('secret storage', () => {
  const key = randomBytes(32);

  it('round trips a secret', () => {
    const encrypted = encryptSecret('super-secret-bind-password', key);
    expect(encrypted).not.toContain('super-secret-bind-password');
    expect(decryptSecret(encrypted, key)).toBe('super-secret-bind-password');
  });

  it('produces a different ciphertext every time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('secret', key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow(SecretDecryptionError);
  });

  it('detects tampering', () => {
    const encrypted = encryptSecret('secret', key);
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow(SecretDecryptionError);
  });
});

describe('session tokens', () => {
  const secret = 'a-secret-that-is-at-least-32-characters-long';

  const controlPlaneToken = (ttl = 60): string =>
    issueToken<SessionClaims>(
      { sub: 'user-1', aud: 'control-plane', username: 'admin', permissions: ['AUDIT_READ'] },
      secret,
      ttl,
    ).token;

  const portalToken = (ttl = 60): string =>
    issueToken<PortalClaims>(
      { sub: 'local:alice', aud: 'proxy-portal', username: 'alice', providerKey: 'local', groups: ['Developers'] },
      secret,
      ttl,
    ).token;

  it('issues and verifies a control plane token', () => {
    const verified = verifyToken<SessionClaims>(controlPlaneToken(), secret, 'control-plane');
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.claims.sub).toBe('user-1');
      expect(verified.claims.permissions).toEqual(['AUDIT_READ']);
    }
  });

  it('issues and verifies a portal token', () => {
    const verified = verifyToken<PortalClaims>(portalToken(), secret, 'proxy-portal');
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.claims.providerKey).toBe('local');
      expect(verified.claims.groups).toEqual(['Developers']);
    }
  });

  /*
   * The security boundary of the self-service portal: both audiences are signed
   * with the same key, so only the audience check keeps a proxy user out of the
   * control plane API (PRODUCT.md section 1).
   */
  it('refuses a portal token on a control plane audience', () => {
    expect(verifyToken(portalToken(), secret, 'control-plane')).toEqual({
      valid: false,
      reason: 'WRONG_AUDIENCE',
    });
  });

  it('refuses a control plane token on the portal audience', () => {
    expect(verifyToken(controlPlaneToken(), secret, 'proxy-portal')).toEqual({
      valid: false,
      reason: 'WRONG_AUDIENCE',
    });
  });

  it('refuses a token without an audience claim', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u', username: 'a', permissions: ['CP_USER_MANAGE'], exp: Date.now() / 1000 + 60 }),
    ).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    expect(verifyToken(`${header}.${body}.${signature}`, secret, 'control-plane')).toEqual({
      valid: false,
      reason: 'WRONG_AUDIENCE',
    });
  });

  it('rejects a token signed with another secret', () => {
    const verified = verifyToken(controlPlaneToken(), 'another-secret-that-is-at-least-32-chars', 'control-plane');
    expect(verified).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects an expired token', () => {
    expect(verifyToken(controlPlaneToken(-1), secret, 'control-plane')).toEqual({
      valid: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects the alg=none downgrade', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'u', exp: Date.now() / 1000 + 60 })).toString('base64url');
    expect(verifyToken(`${header}.${body}.`, secret, 'control-plane').valid).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyToken('', secret, 'control-plane').valid).toBe(false);
    expect(verifyToken('a.b', secret, 'control-plane').valid).toBe(false);
    expect(verifyToken('a.b.c.d', secret, 'control-plane').valid).toBe(false);
  });
});

describe('audit redaction', () => {
  it('removes password-like keys at any depth', () => {
    const payload = redactAuditPayload({
      username: 'alice',
      password: 'hunter2',
      nested: { bindPassword: 'secret', newPassword: 'x', keep: 'visible' },
      list: [{ passwordHash: '$6$abc$def' }],
    }) as Record<string, unknown>;

    expect(JSON.stringify(payload)).not.toContain('hunter2');
    expect(JSON.stringify(payload)).not.toContain('$6$abc$def');
    expect(payload.username).toBe('alice');
    expect((payload.nested as Record<string, unknown>).keep).toBe('visible');
    expect((payload.nested as Record<string, unknown>).bindPassword).toBe(REDACTED);
  });

  it('handles null, arrays and primitives', () => {
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload([1, 'two'])).toEqual([1, 'two']);
    expect(redactAuditPayload('plain')).toBe('plain');
  });
});

describe('ldap filter escaping', () => {
  it('escapes RFC 4515 special characters', () => {
    expect(escapeLdapFilterValue('a*b(c)d\\e')).toBe('a\\2ab\\28c\\29d\\5ce');
  });

  it('neutralises a filter injection attempt', () => {
    const filter = renderFilter('(uid=%s)', { '%s': 'admin)(|(uid=*' });
    expect(filter).toBe('(uid=admin\\29\\28|\\28uid=\\2a)');
    expect(filter.split('(').length - 1).toBe(1);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit and then blocks', () => {
    const limiter = new RateLimiter(3, 1000);
    const now = 1_000_000;
    expect(limiter.check('k', now).allowed).toBe(true);
    expect(limiter.check('k', now).allowed).toBe(true);
    expect(limiter.check('k', now).allowed).toBe(true);
    const blocked = limiter.check('k', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('lets the window slide', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('k', 1000).allowed).toBe(true);
    expect(limiter.check('k', 1500).allowed).toBe(false);
    expect(limiter.check('k', 2500).allowed).toBe(true);
  });

  it('resets after a successful login', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.check('k', 1000);
    limiter.reset('k');
    expect(limiter.check('k', 1000).allowed).toBe(true);
  });

  it('keeps buckets separate', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('a', 1000).allowed).toBe(true);
    expect(limiter.check('b', 1000).allowed).toBe(true);
  });
});
