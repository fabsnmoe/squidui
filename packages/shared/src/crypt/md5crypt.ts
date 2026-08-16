/**
 * MD5 based crypt(3) (`$1$`).
 *
 * Kept as a fallback format for authentication helpers whose crypt(3) does not
 * offer SHA-512. It is weaker than `$6$` and is only selected explicitly via
 * `PROXY_PASSWORD_HASH_FORMAT`.
 */

import { createHash } from 'node:crypto';
import { encodeDigest } from './b64.js';

export const MD5_PREFIX = '$1$';
export const MD5_MAX_SALT = 8;
const ROUNDS = 1000;

const PERMUTATION: readonly number[][] = [
  [0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5],
];

function md5(parts: readonly Buffer[]): Buffer {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function md5Crypt(password: string, salt: string): string {
  const key = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'utf8').subarray(0, MD5_MAX_SALT);
  const keyLen = key.length;

  const b = md5([key, saltBytes, key]);

  const parts: Buffer[] = [key, Buffer.from(MD5_PREFIX, 'utf8'), saltBytes];
  let remaining = keyLen;
  while (remaining > 16) {
    parts.push(b);
    remaining -= 16;
  }
  parts.push(b.subarray(0, remaining));

  // The reference implementation appends a NUL byte for every set bit and the
  // first key byte for every clear bit. It is odd, but compatibility requires
  // reproducing it exactly.
  const zero = Buffer.from([0]);
  const firstKeyByte = keyLen > 0 ? key.subarray(0, 1) : Buffer.alloc(0);
  for (let bits = keyLen; bits > 0; bits >>= 1) {
    parts.push((bits & 1) !== 0 ? zero : firstKeyByte);
  }

  let a = md5(parts);
  for (let i = 0; i < ROUNDS; i += 1) {
    const round: Buffer[] = [];
    round.push((i & 1) !== 0 ? key : a);
    if (i % 3 !== 0) round.push(saltBytes);
    if (i % 7 !== 0) round.push(key);
    round.push((i & 1) !== 0 ? a : key);
    a = md5(round);
  }

  const encoded = encodeDigest(a, PERMUTATION, [11, 2]);
  return `${MD5_PREFIX}${saltBytes.toString('utf8')}$${encoded}`;
}

export function parseMd5Hash(hash: string): { salt: string } | null {
  if (!hash.startsWith(MD5_PREFIX)) return null;
  const body = hash.slice(MD5_PREFIX.length);
  const saltEnd = body.indexOf('$');
  if (saltEnd === -1) return null;
  return { salt: body.slice(0, saltEnd) };
}
