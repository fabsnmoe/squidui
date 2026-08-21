/**
 * The access log format the control plane generates and parses.
 *
 * Agents ship raw lines and do not parse them: keeping the format knowledge in
 * one place means a format change is a control plane deployment, not a fleet
 * wide agent rollout. The name carries a version, and the parser accepts every
 * version it has ever emitted - during a reconfigure a log file legitimately
 * contains lines from both the old and the new format.
 */

export const ACCESS_LOG_FORMAT_NAME = 'scp_v2';

/*
 * %ts.%03tu  timestamp, seconds and milliseconds
 * %>a        client address
 * %[un       user name, '-' when the request carried no identity
 * %Ss        Squid request status, e.g. TCP_MISS or TCP_DENIED (cache result)
 * %03>Hs     HTTP status sent to the client
 * %<st       bytes received from the server
 * %tr        response time in milliseconds
 * %rm        request method
 * %ru        request URL - last on purpose, because it may contain the separator
 *
 * There is deliberately no format code for the destination port: it is derived
 * from the URL, which works for both absolute URLs and CONNECT targets and
 * avoids depending on a code that differs between Squid builds.
 */
export const ACCESS_LOG_FORMAT = 'v2|%ts.%03tu|%>a|%[un|%Ss|%03>Hs|%<st|%tr|%rm|%ru';

/**
 * v1 had no version token and no response time. v2 leads with an explicit
 * token, because the field count cannot be used to tell versions apart: the
 * URL is last precisely so it may contain the separator, which makes the count
 * variable.
 */
const V2_PREFIX = 'v2|';
const V1_FIELDS = 8;
const V2_FIELDS = 9;

export type TrafficDecision = 'ALLOWED' | 'DENIED' | 'AUTH_REQUIRED' | 'ERROR';

export interface AccessLogEntry {
  occurredAt: string;
  clientIp: string | null;
  username: string | null;
  /** Squid request status; this is the cache result, e.g. TCP_MISS. */
  squidStatus: string | null;
  httpStatus: number | null;
  bytes: number | null;
  durationMs: number | null;
  method: string | null;
  url: string | null;
  destinationHost: string | null;
  destinationPort: number | null;
  /** The policy result, derived from the cache and HTTP status. */
  decision: TrafficDecision;
}

/** Squid writes '-' for anything it does not have. */
function value(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

function numeric(raw: string | undefined): number | null {
  const text = value(raw);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The host a request was aimed at. CONNECT logs `host:port`, ordinary requests
 * log an absolute URL, and a malformed line must not throw.
 */
export function destinationHostOf(url: string | null, method: string | null): string | null {
  if (!url) return null;
  if (method === 'CONNECT') return url.split(':')[0] ?? url;
  try {
    return new URL(url).hostname;
  } catch {
    const match = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url);
    return match?.[1] ?? null;
  }
}

/**
 * The port a request was aimed at, derived rather than logged.
 *
 * CONNECT targets carry it explicitly; absolute URLs carry it only when it is
 * not the scheme default, so the scheme supplies the rest.
 */
export function destinationPortOf(url: string | null, method: string | null): number | null {
  if (!url) return null;

  if (method === 'CONNECT') {
    const port = Number(url.split(':')[1]);
    return Number.isFinite(port) ? port : 443;
  }

  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return Number(parsed.port);
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    if (parsed.protocol === 'ftp:') return 21;
    return null;
  } catch {
    const match = /^[a-z]+:\/\/[^/:?#]+:(\d+)/i.exec(url);
    return match?.[1] ? Number(match[1]) : null;
  }
}

/**
 * A 407 is a credentials challenge rather than a refusal - conflating the two
 * makes the dashboard report a denial every time a client is simply asked to
 * authenticate, which is the first request of every session.
 */
export function decisionOf(squidStatus: string | null, httpStatus: number | null): TrafficDecision {
  // A challenge is not a denial: the client may still come back with credentials.
  if (httpStatus === 407) return 'AUTH_REQUIRED';
  if (squidStatus?.includes('DENIED')) return 'DENIED';

  // Squid's result code is what says whether the proxy served the request at
  // all, and that is the question this column answers. NONE_* means it never
  // forwarded or tunnelled anything - a malformed request from a scanner
  // (NONE_NONE/400 error:invalid-request), a connection that ended before the
  // headers (NONE_NONE/000), a TLS handshake against the plaintext port.
  //
  // Reading the HTTP status alone called all of those "Allowed", which in a
  // tool for access control is the one wrong thing to say about a request that
  // was never allowed at all.
  if (squidStatus !== null && squidStatus.startsWith('NONE')) return 'ERROR';

  // A 5xx from the origin travelled through an allowed request, but an operator
  // scanning a traffic log for problems wants it visible, and the status column
  // still shows which one it was.
  if (httpStatus !== null && httpStatus >= 500) return 'ERROR';

  // Without a result code - a v1 line - the status is all there is.
  if (squidStatus === null && httpStatus !== null && httpStatus >= 400) return 'ERROR';

  return 'ALLOWED';
}

/** Returns null for anything that is not a line in a format we have emitted. */
export function parseAccessLogLine(line: string): AccessLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // An explicit token, not the field count: the URL is last so that it may
  // contain the separator, which makes counting fields unreliable by design.
  const isV2 = trimmed.startsWith(V2_PREFIX);
  const body = isV2 ? trimmed.slice(V2_PREFIX.length) : trimmed;
  const headCount = isV2 ? V2_FIELDS - 1 : V1_FIELDS - 1;

  const parts = body.split('|');
  if (parts.length < headCount + 1) return null;

  const head = parts.slice(0, headCount);
  const url = value(parts.slice(headCount).join('|'));

  const seconds = Number(head[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const httpStatus = numeric(head[4]);
  const method = value(isV2 ? head[7] : head[6]);
  const squidStatus = value(head[3]);

  return {
    occurredAt: new Date(seconds * 1000).toISOString(),
    clientIp: value(head[1]),
    username: value(head[2]),
    squidStatus,
    httpStatus,
    bytes: numeric(head[5]),
    durationMs: isV2 ? numeric(head[6]) : null,
    method,
    url,
    destinationHost: destinationHostOf(url, method),
    destinationPort: destinationPortOf(url, method),
    decision: decisionOf(squidStatus, httpStatus),
  };
}
