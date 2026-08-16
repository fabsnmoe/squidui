/**
 * IP address and CIDR helpers.
 *
 * Both IPv4 and IPv6 are represented as a big-endian `bigint` plus a family,
 * which keeps containment checks to a single mask comparison and avoids any
 * dependency on Node's `net` module (this file must stay usable in a browser
 * bundle).
 */

export type IpFamily = 4 | 6;

export interface IpAddress {
  family: IpFamily;
  value: bigint;
}

export interface Cidr {
  family: IpFamily;
  /** Network address with all host bits cleared. */
  base: bigint;
  prefix: number;
  /** Total address width: 32 for IPv4, 128 for IPv6. */
  bits: number;
  /** Normalised text form, e.g. `10.0.0.0/8`. */
  text: string;
}

const V4_BITS = 32;
const V6_BITS = 128;

function maskFor(prefix: number, bits: number): bigint {
  if (prefix <= 0) return 0n;
  const width = BigInt(bits);
  const host = width - BigInt(prefix);
  return ((1n << width) - 1n) ^ ((1n << host) - 1n);
}

export function parseIpv4(input: string): bigint | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    // Reject leading zeros ("010.0.0.1") - they are ambiguous and some
    // resolvers read them as octal.
    if (part.length > 1 && part.startsWith('0')) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

export function parseIpv6(input: string): bigint | null {
  let text = input;
  // An IPv4-mapped tail (::ffff:192.0.2.1) is expanded into two hextets.
  const v4Tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4Tail?.[1]) {
    const v4 = parseIpv4(v4Tail[1]);
    if (v4 === null) return null;
    const high = (v4 >> 16n) & 0xffffn;
    const low = v4 & 0xffffn;
    text = `${text.slice(0, v4Tail.index)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null;

  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = text.split(':');
    tail = [];
  } else {
    const headText = text.slice(0, doubleColon);
    const tailText = text.slice(doubleColon + 2);
    head = headText === '' ? [] : headText.split(':');
    tail = tailText === '' ? [] : tailText.split(':');
  }

  const groups = [...head, ...tail];
  if (groups.length > 8) return null;
  if (doubleColon === -1 && groups.length !== 8) return null;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }

  const fill = 8 - groups.length;
  const full = [...head, ...Array.from({ length: fill }, () => '0'), ...tail];
  let value = 0n;
  for (const group of full) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

export function parseIp(input: string): IpAddress | null {
  const text = input.trim();
  if (text === '') return null;
  if (text.includes(':')) {
    const value = parseIpv6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
}

export function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

/** Parses `10.0.0.0/8`, `2001:db8::/32` or a bare address (implicit /32, /128). */
export function parseCidr(input: string): Cidr | null {
  const text = input.trim();
  if (text === '') return null;
  const slash = text.lastIndexOf('/');
  const addressText = slash === -1 ? text : text.slice(0, slash);
  const address = parseIp(addressText);
  if (!address) return null;

  const bits = address.family === 4 ? V4_BITS : V6_BITS;
  let prefix = bits;
  if (slash !== -1) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > bits) return null;
  }

  const base = address.value & maskFor(prefix, bits);
  const baseText = address.family === 4 ? formatIpv4(base) : formatIpv6(base);
  return { family: address.family, base, prefix, bits, text: `${baseText}/${prefix}` };
}

export function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  // Compress the longest run of zero groups (RFC 5952).
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (start === -1) start = i;
      length += 1;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
    } else {
      start = -1;
      length = 0;
    }
  }
  if (bestLength < 2) return groups.join(':');
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

export function cidrContains(cidr: Cidr, address: IpAddress): boolean {
  if (cidr.family !== address.family) return false;
  return (address.value & maskFor(cidr.prefix, cidr.bits)) === cidr.base;
}

export function ipInAnyCidr(address: IpAddress, cidrs: readonly string[]): boolean {
  for (const text of cidrs) {
    const cidr = parseCidr(text);
    if (cidr && cidrContains(cidr, address)) return true;
  }
  return false;
}

/** `0.0.0.0/0` or `::/0` - matches the entire address space. */
export function isUnspecifiedRange(cidr: Cidr): boolean {
  return cidr.prefix === 0;
}

const PRIVATE_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10', // CGNAT
];

const PRIVATE_V6 = [
  'fc00::/7', // unique local
  'fe80::/10', // link local
  '::1/128',
];

/**
 * True when the whole range is reserved for private/internal use. A range that
 * only partially overlaps a private block (e.g. `10.0.0.0/4`) is not private -
 * that is the conservative answer for the open proxy check.
 */
export function isPrivateCidr(cidr: Cidr): boolean {
  const candidates = cidr.family === 4 ? PRIVATE_V4 : PRIVATE_V6;
  for (const text of candidates) {
    const block = parseCidr(text);
    if (!block) continue;
    if (cidr.prefix < block.prefix) continue;
    if ((cidr.base & maskFor(block.prefix, block.bits)) === block.base) return true;
  }
  return false;
}

/** Number of addresses covered, useful for "how wide is this really" checks. */
export function cidrSize(cidr: Cidr): bigint {
  return 1n << BigInt(cidr.bits - cidr.prefix);
}
