/**
 * The base64 variant used by crypt(3). It has its own alphabet and emits
 * groups little-endian, which is why the standard base64 encoder cannot be
 * used here.
 */

export const CRYPT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Encodes three bytes as `count` characters, six bits at a time, starting at
 * the least significant bits (`b64_from_24bit` in the reference sources).
 */
export function b64From24Bit(b2: number, b1: number, b0: number, count: number): string {
  let value = ((b2 & 0xff) << 16) | ((b1 & 0xff) << 8) | (b0 & 0xff);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += CRYPT_ALPHABET[value & 0x3f];
    value >>= 6;
  }
  return out;
}

/**
 * Encodes a digest using a permutation table of byte indices. The table holds
 * triples of indices in the order the reference implementation emits them.
 */
export function encodeDigest(digest: Buffer, triples: readonly number[][], tail: [number, number]): string {
  let out = '';
  for (const triple of triples) {
    const [i2, i1, i0] = triple as [number, number, number];
    out += b64From24Bit(digest[i2] ?? 0, digest[i1] ?? 0, digest[i0] ?? 0, 4);
  }
  const [tailIndex, tailCount] = tail;
  out += b64From24Bit(0, 0, digest[tailIndex] ?? 0, tailCount);
  return out;
}

/** Repeats `source` until `length` bytes are produced. */
export function repeatTo(source: Buffer, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += source.length) {
    source.copy(out, offset, 0, Math.min(source.length, length - offset));
  }
  return out;
}
