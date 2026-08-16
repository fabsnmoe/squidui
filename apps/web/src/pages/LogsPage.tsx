import { useState } from 'react';
import {
  Card,
  DataTable,
  FilterBar,
  InlineAlert,
  MetricCard,
  Page,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  type Column,
} from '@scp/ui';
import { api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { formatDateTime } from '../lib/display.js';

/**
 * Observability -> Logs (PLAN.md 9.23).
 *
 * The filters are the ones an operator actually reaches for: was this request
 * made by a known identity, by a specific user, or by nobody in particular.
 */

interface TrafficEvent {
  id: string;
  occurred_at: string;
  client_ip: string | null;
  username: string | null;
  http_status: number | null;
  duration_ms: number | null;
  destination_port: number | null;
  method: string | null;
  destination_host: string | null;
  url: string | null;
  decision: 'ALLOWED' | 'DENIED' | 'AUTH_REQUIRED' | 'ERROR';
  node_name: string;
}

interface EventsResponse {
  items: TrafficEvent[];
  hours: number;
  urlsRecorded: boolean;
  retentionDays: number;
}

interface SummaryResponse {
  available: boolean;
  hours: number;
  authenticatedRequests: number;
  unauthenticatedRequests: number;
  deniedRequests: number;
  authRequiredRequests: number;
  topUsers: Array<{ username: string; requests: string }>;
}

const DECISION_TONE = {
  ALLOWED: 'success',
  DENIED: 'danger',
  AUTH_REQUIRED: 'warning',
  ERROR: 'danger',
} as const;

const DECISION_LABEL = {
  ALLOWED: 'Allowed',
  DENIED: 'Denied',
  AUTH_REQUIRED: 'Challenged',
  ERROR: 'Error',
} as const;

export function LogsPage(): JSX.Element {
  const [identity, setIdentity] = useState('ANY');
  const [username, setUsername] = useState('');
  const [decision, setDecision] = useState('');
  const [host, setHost] = useState('');
  const [hours, setHours] = useState('24');

  const events = useQuery<EventsResponse>(
    (signal) =>
      api('/traffic/events', {
        signal,
        query: {
          identity,
          username: identity === 'USER' && username ? username : undefined,
          decision: decision || undefined,
          host: host || undefined,
          hours,
          limit: 200,
        },
      }),
    [identity, username, decision, host, hours],
  );

  const summary = useQuery<SummaryResponse>(
    (signal) => api('/traffic/summary', { signal, query: { hours } }),
    [hours],
  );

  const columns: Array<Column<TrafficEvent>> = [
    {
      id: 'when',
      header: 'When',
      sortValue: (row) => row.occurred_at,
      cell: (row) => <span className="scp-numeric scp-hint">{formatDateTime(row.occurred_at)}</span>,
    },
    {
      id: 'identity',
      header: 'Identity',
      cell: (row) =>
        row.username ? (
          <span className="scp-mono">{row.username}</span>
        ) : (
          <StatusBadge tone="neutral">Unauthenticated</StatusBadge>
        ),
    },
    {
      id: 'client',
      header: 'Client',
      cell: (row) => <span className="scp-mono scp-hint">{row.client_ip ?? '—'}</span>,
    },
    {
      id: 'destination',
      header: 'Destination',
      cell: (row) => (
        <div style={{ maxWidth: 360 }}>
          <div className="scp-mono">
            {row.destination_host ?? '—'}
            {row.destination_port ? <span className="scp-hint">:{row.destination_port}</span> : null}
          </div>
          {row.url && row.url !== row.destination_host ? (
            <div
              className="scp-hint scp-mono"
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={row.url}
            >
              {row.url}
            </div>
          ) : null}
        </div>
      ),
    },
    { id: 'method', header: 'Method', cell: (row) => <span className="scp-mono">{row.method ?? '—'}</span> },
    {
      id: 'decision',
      header: 'Result',
      cell: (row) => (
        <span className="scp-row">
          <StatusBadge tone={DECISION_TONE[row.decision]}>{DECISION_LABEL[row.decision]}</StatusBadge>
          <span className="scp-hint scp-numeric">{row.http_status ?? ''}</span>
        </span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'right',
      cell: (row) => (
        <span className="scp-numeric scp-hint">{row.duration_ms === null ? '—' : `${row.duration_ms} ms`}</span>
      ),
    },
    { id: 'node', header: 'Node', cell: (row) => <span className="scp-hint">{row.node_name}</span> },
  ];

  const data = summary.data;
  const retention = events.data?.retentionDays ?? 30;

  return (
    <Page width="wide">
      <PageHeader
        title="Traffic logs"
        description="Requests as the proxy nodes reported them. Individual requests are kept for a limited window; the counters come from hourly aggregates and outlive them."
      />

      {data && !data.available ? (
        <InlineAlert tone="info" title="No node has reported traffic yet">
          Logs appear once an enrolled node has served requests and its agent has shipped the first batch. Check under
          Infrastructure that at least one node is enrolled and in sync.
        </InlineAlert>
      ) : null}

      {data?.available ? (
        <div className="scp-grid">
          <MetricCard
            label="Authenticated requests"
            value={data.authenticatedRequests}
            hint={`Last ${data.hours} hours`}
          />
          <MetricCard
            label="Unauthenticated requests"
            value={data.unauthenticatedRequests}
            hint="Requests without a proxy identity"
          />
          <MetricCard label="Denied" value={data.deniedRequests} hint="Blocked by an access rule" />
          <MetricCard
            label="Challenged"
            value={data.authRequiredRequests}
            hint="Asked for credentials — not a denial"
          />
        </div>
      ) : null}

      <FilterBar>
        <div style={{ width: 220 }}>
          <Select
            label="Identity"
            value={identity}
            options={[
              { value: 'ANY', label: 'Any identity' },
              { value: 'AUTHENTICATED', label: 'Authenticated only' },
              { value: 'UNAUTHENTICATED', label: 'Unauthenticated only' },
              { value: 'USER', label: 'A specific user' },
            ]}
            onChange={(event) => setIdentity(event.target.value)}
          />
        </div>
        {identity === 'USER' ? (
          <SearchInput value={username} onChange={setUsername} placeholder="Username" label="Filter by username" />
        ) : null}
        <SearchInput value={host} onChange={setHost} placeholder="Destination host" label="Filter by host" />
        <div style={{ width: 170 }}>
          <Select
            label="Result"
            value={decision}
            placeholder="Any result"
            options={[
              { value: 'ALLOWED', label: 'Allowed' },
              { value: 'DENIED', label: 'Denied' },
              { value: 'AUTH_REQUIRED', label: 'Challenged' },
              { value: 'ERROR', label: 'Error' },
            ]}
            onChange={(event) => setDecision(event.target.value)}
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            label="Window"
            value={hours}
            options={[
              { value: '1', label: 'Last hour' },
              { value: '24', label: 'Last 24 hours' },
              { value: '168', label: 'Last 7 days' },
            ]}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>
      </FilterBar>

      {events.data && !events.data.urlsRecorded ? (
        <InlineAlert tone="info" title="Full URLs are not recorded">
          This installation stores the destination host and port, but not the path or query string. Full URLs are
          personal data, so recording them is a deliberate choice under System.
        </InlineAlert>
      ) : null}

      <Card flush>
        <DataTable
          columns={columns}
          rows={events.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Traffic log"
          loading={events.loading}
          error={events.error}
          onRetry={events.reload}
          empty={{
            icon: 'file',
            title: 'No requests match these filters',
            description: `Individual requests are kept for ${retention} days. Widen the window or clear the filters.`,
          }}
        />
      </Card>

      {data?.available && data.topUsers.length > 0 ? (
        <Card title="Most active identities" description={`By request count over the last ${data.hours} hours.`}>
          <div className="scp-stack" style={{ gap: 'var(--space-2)' }}>
            {data.topUsers.map((entry) => (
              <div key={entry.username} className="scp-row">
                <span className="scp-mono">{entry.username}</span>
                <span className="scp-spacer" />
                <span className="scp-numeric">{entry.requests}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
