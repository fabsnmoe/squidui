import { Card, DataTable, Page, PageHeader, StatusBadge, type Column } from '@scp/ui';
import { api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { formatDateTime } from '../lib/display.js';

interface Node {
  id: string;
  name: string;
  hostname: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' | 'UNKNOWN';
  squid_version: string | null;
  adapter_id: string;
  last_seen_at: string | null;
}

const TONE = { HEALTHY: 'success', DEGRADED: 'warning', UNREACHABLE: 'danger', UNKNOWN: 'neutral' } as const;

export function NodesPage(): JSX.Element {
  const nodes = useQuery<{ items: Node[] }>((signal) => api('/nodes', { signal }));

  const columns: Array<Column<Node>> = [
    { id: 'name', header: 'Node', sortValue: (row) => row.name, cell: (row) => row.name },
    { id: 'hostname', header: 'Hostname', cell: (row) => <span className="scp-mono">{row.hostname}</span> },
    { id: 'status', header: 'Status', cell: (row) => <StatusBadge tone={TONE[row.status]}>{row.status}</StatusBadge> },
    { id: 'version', header: 'Squid', cell: (row) => row.squid_version ?? <span className="scp-muted">Unknown</span> },
    { id: 'seen', header: 'Last seen', cell: (row) => <span className="scp-numeric">{formatDateTime(row.last_seen_at)}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Proxy nodes"
        description="The Squid instances this control plane manages. Enrollment and status reporting arrive with the node agent."
      />
      <Card flush>
        <DataTable
          columns={columns}
          rows={nodes.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Proxy nodes"
          loading={nodes.loading}
          error={nodes.error}
          onRetry={nodes.reload}
          empty={{
            icon: 'server',
            title: 'No nodes registered',
            description:
              'Node enrollment is part of the agent phase and not available in this release. Generated configuration can already be reviewed under Configuration.',
          }}
        />
      </Card>
    </Page>
  );
}
