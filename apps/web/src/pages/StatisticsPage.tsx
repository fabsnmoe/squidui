import { useMemo, useState } from 'react';
import {
  BarList,
  Card,
  ErrorState,
  InlineAlert,
  Input,
  MetricCard,
  Page,
  PageHeader,
  Select,
  Skeleton,
  TimeSeriesChart,
  type BarListEntry,
  type TimePoint,
} from '@scp/ui';
import { api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';

/**
 * Observability → Statistics (docs/design/statistics.md).
 *
 * Two stores answer this page. The API decides which one can serve the range
 * and the filters being asked for, and says so; the page repeats that to the
 * reader instead of quietly showing fewer cards. A statistics page that changes
 * what its numbers mean without saying so teaches people to mistrust all of it.
 */

interface Row {
  key?: string;
  username?: string;
  host?: string;
  client_ip?: string;
  requests: string;
  bytes?: string;
}

interface StatisticsResponse {
  window: { from: string; to: string };
  granularity: string;
  granularitySeconds: number;
  requestedInterval: string;
  source: 'events' | 'rollups';
  coverage: {
    rawRetentionDays: number;
    statisticsRetentionDays: number;
    rawAvailableFrom: string;
    detailFiltersAvailable: boolean;
    truncatedToRawRetention: boolean;
    appliedDetailFilter: string | null;
    fineWindowDays: number;
    fineBucketMinutes: number;
    coarsenedBefore: string | null;
  };
  totals: Record<string, string>;
  series: Array<Record<string, string>>;
  topUsers: Row[];
  topUsersByBytes?: Row[];
  topDestinations: Row[];
  topClients: Row[];
  deniedDestinations?: Row[];
  methodMix?: Row[];
  errorReasons?: Row[];
  hourOfDay: Array<{ hour: number; requests: string }>;
  unavailable: string[];
}

const PRESETS: Array<{ value: string; label: string; hours: number }> = [
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { value: '90d', label: 'Last 90 days', hours: 24 * 90 },
  { value: '1y', label: 'Last year', hours: 24 * 365 },
  { value: 'custom', label: 'Custom range…', hours: 0 },
];

const num = (value: string | undefined): number => Number(value ?? 0) || 0;

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)} %`;

/** A local datetime string the browser's datetime-local input understands. */
function localInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const listOf = (rows: Row[] | undefined, label: (row: Row) => string): BarListEntry[] =>
  (rows ?? []).map((row, index) => ({
    key: `${label(row)}-${index}`,
    label: label(row),
    value: num(row.requests),
    detail: row.bytes ? bytes(num(row.bytes)) : undefined,
  }));

export function StatisticsPage(): JSX.Element {
  const [preset, setPreset] = useState('7d');
  const [customFrom, setCustomFrom] = useState(() => localInput(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = useState(() => localInput(new Date()));
  const [nodeId, setNodeId] = useState('');
  const [username, setUsername] = useState('');
  const [clientIp, setClientIp] = useState('');
  const [destination, setDestination] = useState('');
  const [decision, setDecision] = useState('');
  const [method, setMethod] = useState('');
  const [bucketWidth, setBucketWidth] = useState('auto');

  const nodes = useQuery<{ items: Array<{ id: string; name: string }> }>((signal) => api('/nodes', { signal }));
  const users = useQuery<{ items: Array<{ id: string; username: string }> }>((signal) =>
    api('/proxy-users', { signal }),
  );

  const range = useMemo(() => {
    if (preset === 'custom') {
      return { from: new Date(customFrom).toISOString(), to: new Date(customTo).toISOString() };
    }
    const hours = PRESETS.find((entry) => entry.value === preset)?.hours ?? 24;
    const to = new Date();
    return { from: new Date(to.getTime() - hours * 3600_000).toISOString(), to: to.toISOString() };
  }, [preset, customFrom, customTo]);

  const search = useMemo(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (nodeId) params.set('nodeId', nodeId);
    if (username) params.set('username', username);
    if (clientIp) params.set('clientIp', clientIp);
    if (destination) params.set('destination', destination);
    if (decision) params.set('decision', decision);
    if (method) params.set('method', method);
    if (bucketWidth !== 'auto') params.set('interval', bucketWidth);
    return params.toString();
  }, [range, nodeId, username, clientIp, destination, decision, method, bucketWidth]);

  const stats = useQuery<StatisticsResponse>(
    (signal) => api(`/statistics?${search}`, { signal }),
    [search],
  );

  const data = stats.data;
  const totals = data?.totals ?? {};
  const requests = num(totals.requests);

  const points: TimePoint[] = (data?.series ?? []).map((row) => ({
    at: String(row.at),
    values: {
      allowed: num(row.allowed),
      challenged: num(row.challenged),
      denied: num(row.denied),
      errors: num(row.errors),
    },
  }));

  const bytePoints: TimePoint[] = (data?.series ?? []).map((row) => ({
    at: String(row.at),
    values: { bytes: num(row.bytes), bytes_uploaded: num(row.bytes_uploaded) },
  }));

  return (
    <Page>
      <PageHeader
        title="Statistics"
        description="What the proxies did, over any period. Pick a node, a person or an address; the page uses whichever store can answer the range and tells you which one that was."
      />

      <Card title="Filters">
        <div className="scp-filter-row">
          <Select
            label="Node"
            value={nodeId}
            options={[
              { value: '', label: 'All nodes' },
              ...(nodes.data?.items ?? []).map((node) => ({ value: node.id, label: node.name })),
            ]}
            onChange={(event) => setNodeId(event.target.value)}
          />
          <Select
            label="Proxy user"
            value={username}
            options={[
              { value: '', label: 'Everyone' },
              ...(users.data?.items ?? []).map((user) => ({ value: user.username, label: user.username })),
            ]}
            onChange={(event) => setUsername(event.target.value)}
          />
          <Select
            label="Decision"
            value={decision}
            options={[
              { value: '', label: 'Any outcome' },
              { value: 'ALLOWED', label: 'Allowed' },
              { value: 'DENIED', label: 'Denied' },
              { value: 'AUTH_REQUIRED', label: 'Challenged' },
              { value: 'ERROR', label: 'Error' },
            ]}
            onChange={(event) => setDecision(event.target.value)}
          />
          <Select
            label="Aggregation"
            value={bucketWidth}
            hint="Points are collected every 5 minutes and summed into whatever you pick."
            options={[
              { value: 'auto', label: 'Automatic — suited to the period' },
              { value: '5m', label: 'Every 5 minutes' },
              { value: '15m', label: 'Every 15 minutes' },
              { value: '1h', label: 'Hourly' },
              { value: '6h', label: 'Every 6 hours' },
              { value: '1d', label: 'Daily' },
              { value: '7d', label: 'Weekly' },
            ]}
            onChange={(event) => setBucketWidth(event.target.value)}
          />
          <Select
            label="Period"
            value={preset}
            options={PRESETS.map((entry) => ({ value: entry.value, label: entry.label }))}
            onChange={(event) => setPreset(event.target.value)}
          />
        </div>

        {preset === 'custom' ? (
          <div className="scp-filter-row">
            <Input
              label="From"
              type="datetime-local"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <Input
              label="To"
              type="datetime-local"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </div>
        ) : null}

        <div className="scp-filter-row">
          <Input
            label="Client address"
            value={clientIp}
            optional
            hint="Individual requests only"
            onChange={(event) => setClientIp(event.target.value)}
          />
          <Input
            label="Destination"
            value={destination}
            optional
            hint="Matches subdomains too"
            onChange={(event) => setDestination(event.target.value)}
          />
          <Input
            label="Method"
            value={method}
            optional
            hint="CONNECT, GET, POST…"
            onChange={(event) => setMethod(event.target.value)}
          />
        </div>
      </Card>

      {data ? (
        <InlineAlert
          tone={data.coverage.truncatedToRawRetention ? 'warning' : 'info'}
          title={
            data.source === 'events'
              ? 'Counted from individual requests'
              : 'Counted from the hourly statistics'
          }
        >
          {data.coverage.coarsenedBefore ? (
            <>
              <strong>
                Before {new Date(data.coverage.coarsenedBefore).toLocaleDateString()} these counters exist only
                as whole hours.
              </strong>{' '}
              Five minute detail is kept for {data.coverage.fineWindowDays} days and folded into hourly buckets
              after that, so points from before then cannot be finer however they are grouped.{' '}
            </>
          ) : null}
          {data.source === 'events' ? (
            <>
              Every filter applies and the detail is complete, for as far back as individual requests are kept —
              currently {data.coverage.rawRetentionDays} days.
              {data.coverage.truncatedToRawRetention ? (
                <>
                  {' '}
                  <strong>
                    The range you asked for starts earlier than that, so this answer begins at{' '}
                    {new Date(data.coverage.rawAvailableFrom).toLocaleDateString()}.
                  </strong>{' '}
                  The filter “{data.coverage.appliedDetailFilter}” cannot be applied to the hourly statistics.
                </>
              ) : null}
            </>
          ) : (
            <>
              Kept for {data.coverage.statisticsRetentionDays === 0 ? 'as long as the installation exists' : `${data.coverage.statisticsRetentionDays} days`},
              which is why this range can be answered at all. The hourly statistics carry no individual request,
              so response time percentiles, error reasons and the method mix are not available here — filter to
              the last {data.coverage.rawRetentionDays} days to see them.
            </>
          )}
        </InlineAlert>
      ) : null}

      {stats.error ? <ErrorState message={stats.error.message} onRetry={stats.reload} /> : null}

      {stats.loading && !data ? (
        <Card>
          <Skeleton height={120} />
        </Card>
      ) : null}

      {data ? (
        <>
          <div className="scp-metric-grid">
            <MetricCard label="Requests" value={requests.toLocaleString()} />
            <MetricCard label="Delivered to clients" value={bytes(num(totals.bytes))} />
            <MetricCard label="Received from clients" value={bytes(num(totals.bytes_uploaded))} />
            <MetricCard label="Authenticated" value={percent(num(totals.authenticated), requests)} />
            <MetricCard label="Denied" value={percent(num(totals.denied), requests)} />
            <MetricCard label="Errors" value={percent(num(totals.errors), requests)} />
          </div>

          <Card
            title="Requests over time"
            description={`Split by outcome, ${data.granularity}. Pick the form that answers your question.`}
          >
            <TimeSeriesChart
              storageKey="statistics.requests"
              caption="Requests over time, by outcome"
              points={points}
              series={[
                { key: 'allowed', label: 'Allowed', color: 'var(--chart-allowed)' },
                { key: 'challenged', label: 'Challenged', color: 'var(--chart-challenged)' },
                { key: 'denied', label: 'Denied', color: 'var(--chart-denied)' },
                { key: 'errors', label: 'Error', color: 'var(--chart-error)' },
              ]}
            />
          </Card>

          <Card
            title="Bytes over time"
            description="Two directions of one measure, so they share a scale rather than a second axis."
          >
            <TimeSeriesChart
              storageKey="statistics.bytes"
              caption="Bytes delivered to and received from clients over time"
              points={bytePoints}
              format={bytes}
              series={[
                { key: 'bytes', label: 'Delivered to clients', color: 'var(--chart-down)' },
                { key: 'bytes_uploaded', label: 'Received from clients', color: 'var(--chart-up)' },
              ]}
            />
          </Card>

          <div className="scp-card-grid">
            <Card title="Top users" description="By requests.">
              <BarList entries={listOf(data.topUsers, (row) => row.username ?? row.key ?? '—')} />
            </Card>
            {data.topUsersByBytes ? (
              <Card title="Heaviest users" description="By bytes — deliberately a second list.">
                <BarList
                  entries={(data.topUsersByBytes ?? []).map((row, index) => ({
                    key: `${row.username}-${index}`,
                    label: row.username ?? '—',
                    value: num(row.bytes),
                    detail: `${num(row.requests).toLocaleString()} requests`,
                  }))}
                  format={bytes}
                />
              </Card>
            ) : null}
            <Card title="Top destinations">
              <BarList entries={listOf(data.topDestinations, (row) => row.host ?? row.key ?? '—')} />
            </Card>
            <Card title="Top client addresses">
              <BarList entries={listOf(data.topClients, (row) => row.client_ip ?? row.key ?? '—')} />
            </Card>
            {data.deniedDestinations ? (
              <Card title="Denied destinations" description="What the policy is actually stopping.">
                <BarList
                  entries={listOf(data.deniedDestinations, (row) => row.key ?? '—')}
                  color="var(--chart-denied)"
                  empty="Nothing was denied in this range."
                />
              </Card>
            ) : null}
            {data.errorReasons ? (
              <Card title="Error reasons" description="Squid's own result code.">
                <BarList
                  entries={listOf(data.errorReasons, (row) => row.key ?? '—')}
                  color="var(--chart-error)"
                  empty="No errors in this range."
                />
              </Card>
            ) : null}
            {data.methodMix ? (
              <Card title="Traffic mix" description="CONNECT is a tunnel; the rest is plain HTTP.">
                <BarList entries={listOf(data.methodMix, (row) => row.key ?? '—')} />
              </Card>
            ) : null}
            {num(totals.duration_count) > 0 || totals.duration_p95 ? (
              <Card title="Response time" description="Median and 95th percentile.">
                <div className="scp-metric-grid">
                  <MetricCard
                    label="Median"
                    value={totals.duration_p50 ? `${num(totals.duration_p50)} ms` : '—'}
                  />
                  <MetricCard
                    label="95th percentile"
                    value={totals.duration_p95 ? `${num(totals.duration_p95)} ms` : '—'}
                  />
                  <MetricCard label="Slowest" value={`${num(totals.duration_max)} ms`} />
                </div>
                {data.source === 'rollups' ? (
                  <p className="scp-hint">
                    Percentiles cannot be aggregated from hourly counters. Only the mean and the slowest request
                    survive that far back, so this card shows what it has rather than a number that would look
                    like a percentile and not be one.
                  </p>
                ) : null}
              </Card>
            ) : null}
          </div>
        </>
      ) : null}
    </Page>
  );
}
