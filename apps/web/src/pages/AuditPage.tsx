import { useState } from 'react';
import {
  Card,
  DataTable,
  FilterBar,
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

interface AuditEvent {
  id: string;
  occurred_at: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  actor_username: string | null;
  target_type: string | null;
  target_name: string | null;
  source_ip: string | null;
  payload: Record<string, unknown>;
}

const TONE = { SUCCESS: 'success', FAILURE: 'danger', DENIED: 'warning' } as const;

export function AuditPage(): JSX.Element {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');

  const events = useQuery<{ items: AuditEvent[]; total: number; actions: string[] }>(
    (signal) => api('/audit-events', { signal, query: { actor: actor || undefined, action: action || undefined, limit: 100 } }),
    [actor, action],
  );

  const columns: Array<Column<AuditEvent>> = [
    {
      id: 'time',
      header: 'When',
      sortValue: (row) => row.occurred_at,
      cell: (row) => <span className="scp-numeric">{formatDateTime(row.occurred_at)}</span>,
    },
    { id: 'action', header: 'Action', cell: (row) => <span className="scp-mono">{row.action}</span> },
    { id: 'outcome', header: 'Outcome', cell: (row) => <StatusBadge tone={TONE[row.outcome]}>{row.outcome}</StatusBadge> },
    { id: 'actor', header: 'Actor', cell: (row) => row.actor_username ?? <span className="scp-muted">system</span> },
    {
      id: 'target',
      header: 'Target',
      cell: (row) =>
        row.target_name ? (
          <span>
            <span className="scp-mono">{row.target_name}</span>
            {row.target_type ? <span className="scp-hint"> ({row.target_type})</span> : null}
          </span>
        ) : (
          <span className="scp-muted">—</span>
        ),
    },
    { id: 'ip', header: 'Source IP', cell: (row) => <span className="scp-mono">{row.source_ip ?? '—'}</span> },
  ];

  return (
    <Page width="wide">
      <PageHeader
        title="Audit log"
        description="Append-only record of every change. Passwords and test credentials are never part of an audit payload."
      />

      <FilterBar>
        <SearchInput value={actor} onChange={setActor} placeholder="Filter by actor" label="Filter by actor" />
        <div style={{ width: 280 }}>
          <Select
            label="Action"
            value={action}
            placeholder="All actions"
            options={(events.data?.actions ?? []).map((entry) => ({ value: entry, label: entry }))}
            onChange={(event) => setAction(event.target.value)}
          />
        </div>
      </FilterBar>

      <Card flush>
        <DataTable
          columns={columns}
          rows={events.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Audit events"
          loading={events.loading}
          error={events.error}
          onRetry={events.reload}
          empty={{
            icon: 'audit',
            title: actor || action ? 'No events match the filter' : 'No audit events yet',
            description:
              actor || action ? 'Adjust the filters above.' : 'Events appear as soon as something is changed.',
          }}
        />
      </Card>
    </Page>
  );
}
