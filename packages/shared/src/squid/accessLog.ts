/**
 * The access log format the control plane generates and parses.
 *
 * Agents ship raw lines and do not parse them: keeping the format knowledge in
 * one place means a format change is a control plane deployment, not a fleet
 * wide agent rollout. The name carries a version so an older agent's lines are
 * still recognisable after the format moves on.
 */

export const ACCESS_LOG_FORMAT_NAME = 'scp_v1';

/*
 * %ts.%03tu  timestamp, seconds and milliseconds
 * %>a        client address
 * %[un       user name, '-' when the request carried no identity
 * %Ss        Squid request status, e.g. TCP_MISS or TCP_DENIED
 * %03>Hs     HTTP status sent to the client
 * %<st       bytes received from the server
 * %rm        request method
 * %ru        request URL - last on purpose, because it may contain the separator
 */
export const ACCESS_LOG_FORMAT = '%ts.%03tu|%>a|%[un|%Ss|%03>Hs|%<st|%rm|%ru';

const FIELD_COUNT = 8;

export type TrafficDecision = 'ALLOWED' | 'DENIED' | 'AUTH_REQUIRED' | 'ERROR';

export interface AccessLogEntry {
  occurredAt: string;
  clientIp: string | null;
  username: string | null;
  squidStatus: string | null;
  httpStatus: number | null;
  bytes: number | null;
  method: string | null;
  url: string | null;
  destinationHost: string | null;
  decision: TrafficDecision;
}

/** Squid writes '-' for anything it does not have. */
function value(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
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
 * A 407 is a credentials challenge rather than a refusal - conflating the two
 * makes the dashboard report a denial every time a client is simply asked to
 * authenticate.
 */
export function decisionOf(squidStatus: string | null, httpStatus: number | null): TrafficDecision {
  if (httpStatus === 407) return 'AUTH_REQUIRED';
  if (squidStatus?.includes('DENIED')) return 'DENIED';
  if (httpStatus !== null && httpStatus >= 500) return 'ERROR';
  return 'ALLOWED';
}

/** Returns null for anything that is not a line in this format. */
export function parseAccessLogLine(line: string): AccessLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // The URL is last and may itself contain the separator, so the split is
  // limited and the remainder is rejoined.
  const parts = trimmed.split('|');
  if (parts.length < FIELD_COUNT) return null;
  const head = parts.slice(0, FIELD_COUNT - 1);
  const url = parts.slice(FIELD_COUNT - 1).join('|');

  const seconds = Number(head[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const httpStatusRaw = value(head[4]);
  const httpStatus = httpStatusRaw === null ? null : Number(httpStatusRaw);
  const bytesRaw = value(head[5]);
  const bytes = bytesRaw === null ? null : Number(bytesRaw);
  const method = value(head[6]);
  const resolvedUrl = value(url);

  return {
    occurredAt: new Date(seconds * 1000).toISOString(),
    clientIp: value(head[1]),
    username: value(head[2]),
    squidStatus: value(head[3]),
    httpStatus: httpStatus !== null && Number.isFinite(httpStatus) ? httpStatus : null,
    bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
    method,
    url: resolvedUrl,
    destinationHost: destinationHostOf(resolvedUrl, method),
    decision: decisionOf(value(head[3]), httpStatus !== null && Number.isFinite(httpStatus) ? httpStatus : null),
  };
}
