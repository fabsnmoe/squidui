import { describe, expect, it } from 'vitest';
import { decisionOf, destinationHostOf, parseAccessLogLine } from './accessLog.js';

const line = (fields: Partial<Record<string, string>> = {}): string =>
  [
    fields.ts ?? '1755350400.123',
    fields.ip ?? '10.20.0.5',
    fields.user ?? '-',
    fields.status ?? 'TCP_MISS',
    fields.http ?? '200',
    fields.bytes ?? '4096',
    fields.method ?? 'GET',
    fields.url ?? 'http://example.com/page',
  ].join('|');

describe('access log parsing', () => {
  it('parses an anonymous request', () => {
    const entry = parseAccessLogLine(line());
    expect(entry).not.toBeNull();
    expect(entry?.clientIp).toBe('10.20.0.5');
    expect(entry?.username).toBeNull();
    expect(entry?.httpStatus).toBe(200);
    expect(entry?.bytes).toBe(4096);
    expect(entry?.destinationHost).toBe('example.com');
    expect(entry?.decision).toBe('ALLOWED');
    expect(entry?.occurredAt).toBe(new Date(1755350400123).toISOString());
  });

  it('reads the proxy identity when one is present', () => {
    expect(parseAccessLogLine(line({ user: 'alice' }))?.username).toBe('alice');
  });

  /* Squid writes '-' for anything it does not have; that is absence, not a
   * user literally called "-". */
  it('treats a dash as absence', () => {
    const entry = parseAccessLogLine(line({ user: '-', bytes: '-', method: '-' }));
    expect(entry?.username).toBeNull();
    expect(entry?.bytes).toBeNull();
    expect(entry?.method).toBeNull();
  });

  /* The URL is last precisely because it may contain the separator. */
  it('keeps a URL that contains the field separator', () => {
    const entry = parseAccessLogLine(line({ url: 'http://example.com/a|b?x=1|2' }));
    expect(entry?.url).toBe('http://example.com/a|b?x=1|2');
    expect(entry?.destinationHost).toBe('example.com');
  });

  it('handles CONNECT, where the target is host:port rather than a URL', () => {
    const entry = parseAccessLogLine(line({ method: 'CONNECT', url: 'example.com:443' }));
    expect(entry?.destinationHost).toBe('example.com');
  });

  it('rejects anything that is not a line in this format', () => {
    expect(parseAccessLogLine('')).toBeNull();
    expect(parseAccessLogLine('   ')).toBeNull();
    expect(parseAccessLogLine('not|enough|fields')).toBeNull();
    expect(parseAccessLogLine(line({ ts: 'not-a-timestamp' }))).toBeNull();
    expect(parseAccessLogLine('1755350400.0|a|b|c|d|e|f|g'.replace('1755350400.0', '0'))).toBeNull();
  });

  it('does not throw on a malformed URL', () => {
    const entry = parseAccessLogLine(line({ url: ':::not a url:::' }));
    expect(entry).not.toBeNull();
    expect(entry?.destinationHost).toBeNull();
  });
});

describe('decision mapping', () => {
  /* A 407 is a credentials challenge, not a refusal. Conflating the two makes
   * the dashboard report a denial every time a client is merely asked to
   * authenticate, which is the normal first request of every session. */
  it('separates an authentication challenge from a denial', () => {
    expect(decisionOf('TCP_DENIED', 407)).toBe('AUTH_REQUIRED');
    expect(decisionOf('TCP_DENIED', 403)).toBe('DENIED');
  });

  it('maps allowed and failing requests', () => {
    expect(decisionOf('TCP_MISS', 200)).toBe('ALLOWED');
    expect(decisionOf('TCP_MISS', 502)).toBe('ERROR');
    expect(decisionOf(null, null)).toBe('ALLOWED');
  });
});

describe('destination host extraction', () => {
  it('handles absolute URLs, CONNECT targets and nothing at all', () => {
    expect(destinationHostOf('https://a.example.com/x', 'GET')).toBe('a.example.com');
    expect(destinationHostOf('a.example.com:443', 'CONNECT')).toBe('a.example.com');
    expect(destinationHostOf(null, 'GET')).toBeNull();
  });
});
