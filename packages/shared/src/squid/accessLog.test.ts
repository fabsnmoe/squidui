import { describe, expect, it } from 'vitest';
import { decisionOf, destinationHostOf, destinationPortOf, parseAccessLogLine } from './accessLog.js';

/** A current-format line, with the explicit version token Squid now writes. */
const v2 = (fields: Partial<Record<string, string>> = {}): string =>
  [
    'v2',
    fields.ts ?? '1755350400.123',
    fields.ip ?? '10.20.0.5',
    fields.user ?? '-',
    fields.status ?? 'TCP_MISS',
    fields.http ?? '200',
    fields.bytes ?? '4096',
    fields.duration ?? '42',
    fields.method ?? 'GET',
    fields.url ?? 'http://example.com/page',
  ].join('|');

/** The format shipped before response time existed; still found in a log file
 *  written across a reconfigure. */
const v1 = (fields: Partial<Record<string, string>> = {}): string =>
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
    const entry = parseAccessLogLine(v2());
    expect(entry).not.toBeNull();
    expect(entry?.clientIp).toBe('10.20.0.5');
    expect(entry?.username).toBeNull();
    expect(entry?.httpStatus).toBe(200);
    expect(entry?.bytes).toBe(4096);
    expect(entry?.durationMs).toBe(42);
    expect(entry?.destinationHost).toBe('example.com');
    expect(entry?.destinationPort).toBe(80);
    expect(entry?.decision).toBe('ALLOWED');
    expect(entry?.occurredAt).toBe(new Date(1755350400123).toISOString());
  });

  it('reads the proxy identity when one is present', () => {
    expect(parseAccessLogLine(v2({ user: 'alice' }))?.username).toBe('alice');
  });

  /* Squid writes '-' for anything it does not have; that is absence, not a
   * user literally called "-". */
  it('treats a dash as absence', () => {
    const entry = parseAccessLogLine(v2({ user: '-', bytes: '-', method: '-', duration: '-' }));
    expect(entry?.username).toBeNull();
    expect(entry?.bytes).toBeNull();
    expect(entry?.method).toBeNull();
    expect(entry?.durationMs).toBeNull();
  });

  /*
   * Regression: version detection used to rely on the field count, which is
   * exactly what a URL containing the separator makes unreliable - and the URL
   * is placed last precisely so that it may contain one. A v2 line with such a
   * URL was misread as a different format.
   */
  it('keeps a URL that contains the field separator', () => {
    const entry = parseAccessLogLine(v2({ url: 'http://example.com/a|b?x=1|2' }));
    expect(entry?.url).toBe('http://example.com/a|b?x=1|2');
    expect(entry?.destinationHost).toBe('example.com');
    expect(entry?.method).toBe('GET');
    expect(entry?.durationMs).toBe(42);
  });

  it('still reads the previous format, which a log file contains across a reconfigure', () => {
    const entry = parseAccessLogLine(v1({ user: 'bob' }));
    expect(entry?.username).toBe('bob');
    expect(entry?.method).toBe('GET');
    expect(entry?.destinationHost).toBe('example.com');
    // v1 carried no response time, so it is absent rather than invented.
    expect(entry?.durationMs).toBeNull();
  });

  it('keeps a separator in a URL of the previous format too', () => {
    const entry = parseAccessLogLine(v1({ url: 'http://example.com/a|b' }));
    expect(entry?.url).toBe('http://example.com/a|b');
    expect(entry?.method).toBe('GET');
  });

  it('handles CONNECT, where the target is host:port rather than a URL', () => {
    const entry = parseAccessLogLine(v2({ method: 'CONNECT', url: 'example.com:443' }));
    expect(entry?.destinationHost).toBe('example.com');
    expect(entry?.destinationPort).toBe(443);
  });

  it('rejects anything that is not a line in a format we emit', () => {
    expect(parseAccessLogLine('')).toBeNull();
    expect(parseAccessLogLine('   ')).toBeNull();
    expect(parseAccessLogLine('not|enough|fields')).toBeNull();
    expect(parseAccessLogLine(v2({ ts: 'not-a-timestamp' }))).toBeNull();
    expect(parseAccessLogLine(v2({ ts: '0' }))).toBeNull();
  });

  it('does not throw on a malformed URL', () => {
    const entry = parseAccessLogLine(v2({ url: ':::not a url:::' }));
    expect(entry).not.toBeNull();
    expect(entry?.destinationHost).toBeNull();
    expect(entry?.destinationPort).toBeNull();
  });
});

describe('decision mapping', () => {
  /* A 407 is a credentials challenge, not a refusal. Conflating the two makes
   * the dashboard report a denial for the first request of every session. */
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

describe('destination extraction', () => {
  it('reads the host from absolute URLs and CONNECT targets', () => {
    expect(destinationHostOf('https://a.example.com/x', 'GET')).toBe('a.example.com');
    expect(destinationHostOf('a.example.com:443', 'CONNECT')).toBe('a.example.com');
    expect(destinationHostOf(null, 'GET')).toBeNull();
  });

  /* The port is derived rather than logged, so the scheme has to supply the
   * default when the URL omits it. */
  it('derives the port from the scheme when the URL omits it', () => {
    expect(destinationPortOf('http://example.com/x', 'GET')).toBe(80);
    expect(destinationPortOf('https://example.com/x', 'GET')).toBe(443);
    expect(destinationPortOf('http://example.com:8080/x', 'GET')).toBe(8080);
    expect(destinationPortOf('example.com:8443', 'CONNECT')).toBe(8443);
    expect(destinationPortOf(null, 'GET')).toBeNull();
  });
});
