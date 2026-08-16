/**
 * SHA-512 based crypt(3) (`$6$`), following Ulrich Drepper's specification.
 *
 * This is the default password format for local proxy users because it is what
 * the `basic_ncsa_auth` helper can verify through the platform crypt(3)
 * (docs/architecture/adr/0002-proxy-password-format.md).
 */

import { createHash } from 'node:crypto';
import { encodeDigest, repeatTo } from './b64.js';

export const SHA512_PREFIX = '$6$';
export const SHA512_DEFAULT_ROUNDS = 5000;
export const SHA512_MIN_ROUNDS = 1000;
export const SHA512_MAX_ROUNDS = 999_999_999;
export const SHA512_MAX_SALT = 16;

/** Byte index triples in the order the reference implementation emits them. */
const PERMUTATION: readonly number[][] = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26],
  [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32],
  [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38],
  [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

function sha512(parts: readonly Buffer[]): Buffer {
  const hash = createHash('sha512');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export interface Sha512CryptOptions {
  rounds?: number;
}

/**
 * @param password plaintext, held only for the duration of this call
 * @param salt salt characters without the `$6$` prefix, max 16 characters
 */
export function sha512Crypt(password: string, salt: string, options: Sha512CryptOptions = {}): string {
  const rounds = clampRounds(options.rounds ?? SHA512_DEFAULT_ROUNDS);
  const explicitRounds = options.rounds !== undefined && options.rounds !== SHA512_DEFAULT_ROUNDS;

  const key = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'utf8').subarray(0, SHA512_MAX_SALT);
  const keyLen = key.length;
  const saltLen = saltBytes.length;

  // Digest B
  const b = sha512([key, saltBytes, key]);

  // Digest A
  const aParts: Buffer[] = [key, saltBytes];
  let remaining = keyLen;
  while (remaining > 64) {
    aParts.push(b);
    remaining -= 64;
  }
  aParts.push(b.subarray(0, remaining));
  for (let bits = keyLen; bits > 0; bits >>= 1) {
    aParts.push((bits & 1) !== 0 ? b : key);
  }
  const a = sha512(aParts);

  // Sequence P: the key hashed with itself, repeated to key length
  const dpParts: Buffer[] = [];
  for (let i = 0; i < keyLen; i += 1) dpParts.push(key);
  const p = repeatTo(sha512(dpParts), keyLen);

  // Sequence S: the salt hashed 16 + A[0] times, repeated to salt length
  const dsParts: Buffer[] = [];
  const saltRepeats = 16 + (a[0] ?? 0);
  for (let i = 0; i < saltRepeats; i += 1) dsParts.push(saltBytes);
  const s = repeatTo(sha512(dsParts), saltLen);

  // Round loop - this is the deliberate cost factor
  let c = a;
  for (let i = 0; i < rounds; i += 1) {
    const parts: Buffer[] = [];
    parts.push(i % 2 !== 0 ? p : c);
    if (i % 3 !== 0) parts.push(s);
    if (i % 7 !== 0) parts.push(p);
    parts.push(i % 2 !== 0 ? c : p);
    c = sha512(parts);
  }

  const encoded = encodeDigest(c, PERMUTATION, [63, 2]);
  const prefix = explicitRounds ? `${SHA512_PREFIX}rounds=${rounds}$` : SHA512_PREFIX;
  return `${prefix}${saltBytes.toString('utf8')}$${encoded}`;
}

function clampRounds(rounds: number): number {
  if (!Number.isFinite(rounds)) return SHA512_DEFAULT_ROUNDS;
  return Math.max(SHA512_MIN_ROUNDS, Math.min(SHA512_MAX_ROUNDS, Math.trunc(rounds)));
}

export interface ParsedSha512Hash {
  rounds: number;
  explicitRounds: boolean;
  salt: string;
}

export function parseSha512Hash(hash: string): ParsedSha512Hash | null {
  if (!hash.startsWith(SHA512_PREFIX)) return null;
  let body = hash.slice(SHA512_PREFIX.length);
  let rounds = SHA512_DEFAULT_ROUNDS;
  let explicitRounds = false;
  if (body.startsWith('rounds=')) {
    const end = body.indexOf('$');
    if (end === -1) return null;
    const value = Number(body.slice('rounds='.length, end));
    if (!Number.isInteger(value)) return null;
    rounds = clampRounds(value);
    explicitRounds = true;
    body = body.slice(end + 1);
  }
  const saltEnd = body.indexOf('$');
  if (saltEnd === -1) return null;
  return { rounds, explicitRounds, salt: body.slice(0, saltEnd) };
}
