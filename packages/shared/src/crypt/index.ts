/**
 * Password hashing for both identity planes.
 *
 * Proxy users  -> crypt(3), because an external Squid helper must verify them.
 * Control plane -> scrypt, because nothing outside this process verifies them.
 *
 * Node-only module: it is exported as `@scp/shared/crypt` so the browser
 * bundle never pulls `node:crypto` in.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CRYPT_ALPHABET } from './b64.js';
import { md5Crypt, MD5_MAX_SALT, MD5_PREFIX, parseMd5Hash } from './md5crypt.js';
import {
  parseSha512Hash,
  sha512Crypt,
  SHA512_MAX_SALT,
  SHA512_PREFIX,
} from './sha512crypt.js';

export * from './md5crypt.js';
export * from './sha512crypt.js';
export { CRYPT_ALPHABET } from './b64.js';

export const PROXY_PASSWORD_FORMATS = ['sha512-crypt', 'md5-crypt'] as const;
export type ProxyPasswordFormat = (typeof PROXY_PASSWORD_FORMATS)[number];

export function isProxyPasswordFormat(value: unknown): value is ProxyPasswordFormat {
  return typeof value === 'string' && (PROXY_PASSWORD_FORMATS as readonly string[]).includes(value);
}

/** Random salt drawn from the crypt(3) alphabet. */
export function generateCryptSalt(length: number): string {
  const bytes = randomBytes(length);
  let salt = '';
  for (let i = 0; i < length; i += 1) {
    // 64 character alphabet, so the modulo bias of a byte is negligible only
    // because 256 is an exact multiple of 64.
    salt += CRYPT_ALPHABET[(bytes[i] ?? 0) % CRYPT_ALPHABET.length];
  }
  return salt;
}

/**
 * Hashes a proxy password in the format the deployed Squid helper can verify.
 * The plaintext is never stored, logged or returned (PRODUCT.md section 15).
 */
export function hashProxyPassword(
  password: string,
  format: ProxyPasswordFormat = 'sha512-crypt',
): string {
  if (format === 'md5-crypt') {
    return md5Crypt(password, generateCryptSalt(MD5_MAX_SALT));
  }
  return sha512Crypt(password, generateCryptSalt(SHA512_MAX_SALT));
}

/** Verifies a proxy password against a stored crypt(3) string. */
export function verifyProxyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;

  let computed: string;
  if (storedHash.startsWith(SHA512_PREFIX)) {
    const parsed = parseSha512Hash(storedHash);
    if (!parsed) return false;
    computed = sha512Crypt(
      password,
      parsed.salt,
      parsed.explicitRounds ? { rounds: parsed.rounds } : {},
    );
  } else if (storedHash.startsWith(MD5_PREFIX)) {
    const parsed = parseMd5Hash(storedHash);
    if (!parsed) return false;
    computed = md5Crypt(password, parsed.salt);
  } else {
    return false;
  }

  return constantTimeEquals(computed, storedHash);
}

export function proxyHashFormatOf(storedHash: string): ProxyPasswordFormat | null {
  if (storedHash.startsWith(SHA512_PREFIX)) return 'sha512-crypt';
  if (storedHash.startsWith(MD5_PREFIX)) return 'md5-crypt';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Control plane passwords                                                     */
/* -------------------------------------------------------------------------- */

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISATION = 1;
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash`, all parameters recorded for future migrations. */
export function hashControlPlanePassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISATION,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISATION,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyControlPlanePassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, costText, blockText, parallelText, saltText, hashText] = parts;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelisation = Number(parallelText);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelisation)) {
    return false;
  }
  const salt = Buffer.from(saltText ?? '', 'base64');
  const expected = Buffer.from(hashText ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelisation,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* Password policy                                                             */
/* -------------------------------------------------------------------------- */

export interface PasswordPolicyViolation {
  code: string;
  message: string;
}

export const MIN_PASSWORD_LENGTH = 12;

/** Deliberately simple: length first, then obvious weaknesses. */
export function validatePasswordStrength(password: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push({
      code: 'TOO_SHORT',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  if (password.length > 256) {
    violations.push({ code: 'TOO_LONG', message: 'Use at most 256 characters.' });
  }
  if (/^\s|\s$/.test(password)) {
    violations.push({
      code: 'SURROUNDING_WHITESPACE',
      message: 'Leading or trailing whitespace is not allowed.',
    });
  }
  if (/[\r\n\0]/.test(password)) {
    violations.push({
      code: 'CONTROL_CHARACTER',
      message: 'Line breaks and NUL characters are not allowed.',
    });
  }
  if (/^(.)\1*$/.test(password) && password.length > 0) {
    violations.push({ code: 'REPEATED_CHARACTER', message: 'Do not repeat a single character.' });
  }
  return violations;
}
