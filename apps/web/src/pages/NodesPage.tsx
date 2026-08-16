import { useState } from 'react';
import {
  Button,
  Card,
  CodeViewer,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  HealthIndicator,
  IconButton,
  InlineAlert,
  Input,
  MetricCard,
  Page,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { useSession } from '../lib/session.js';
import { formatDateTime } from '../lib/display.js';

/**
 * Infrastructure -> Nodes.
 *
 * The control plane runs separately from the proxies, so a node is added in two
 * steps: it is declared here, then it claims itself with a one-time enrolment
 * token. Adding the tenth node is the same operation as adding the first.
 */

interface Node {
  id: string;
  name: string;
  description: string | null;
  hostname: string | null;
  adapterId: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' | 'UNKNOWN';
  enrolled: boolean;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  agentVersion: string | null;
  squidVersion: string | null;
  squidRunning: boolean | null;
  hasCredential: boolean;
  pendingEnrollment: boolean;
  apply: { result: string | null; message: string | null; at: string | null };
  lastError: string | null;
  configuration: { currentHash: string; reportedHash: string | null; inSync: boolean; drift: boolean };
  group: { id: string; name: string } | null;
  createdAt: string;
}

interface NodesResponse {
  items: Node[];
  summary: { enrolled: number; inSync: number; drifted: number; unreachable: number };
  adapters: Array<{ id: string; displayName: string; supports: string }>;
}

interface EnrollmentToken {
  token: string;
  expiresAt: string;
  expiresInMinutes: number;
  node: { id: string; name: string };
}

const STATE = {
  HEALTHY: { tone: 'success', label: 'Healthy' },
  DEGRADED: { tone: 'warning', label: 'Degraded' },
  UNREACHABLE: { tone: 'danger', label: 'Unreachable' },
  UNKNOWN: { tone: 'neutral', label: 'Not enrolled' },
} as const;

export function NodesPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const nodes = useQuery<NodesResponse>((signal) => api('/nodes', { signal }));

  const nodeGroups = useQuery<{ items: Array<{ id: string; name: string }> }>((signal) =>
    api('/node-groups', { signal }),
  );
  const [movingGroup, setMovingGroup] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string; hostname: string; adapterId: string } | null>(
    null,
  );
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [detail, setDetail] = useState<Node | null>(null);
  const [deleting, setDeleting] = useState<Node | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('NODE_MANAGE');
  const adapters = nodes.data?.adapters ?? [];

  const issueToken = async (node: Node): Promise<void> => {
    try {
      setEnrollment(await api<EnrollmentToken>(`/nodes/${node.id}/enrollment-token`, { method: 'POST' }));
      nodes.reload();
    } catch (error) {
      toast.error('Could not issue a token', error instanceof ApiError ? error.message : 'Unexpected error.');
    }
  };

  const moveToGroup = async (node: Node, groupId: string | null): Promise<void> => {
    setMovingGroup(true);
    try {
      await api(`/nodes/${node.id}/group`, { method: 'POST', body: { groupId } });
      toast.success('Node moved', groupId ? 'It serves the listeners of its new group.' : 'The node is unassigned.');
      nodes.reload();
    } catch (error) {
      toast.error('Could not move the node', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setMovingGroup(false);
    }
  };

  const createNode = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      const created = await api<Node>('/nodes', {
        method: 'POST',
        body: {
          name: form.name,
          description: form.description || null,
          hostname: form.hostname || null,
          adapterId: form.adapterId,
        },
      });
      setForm(null);
      nodes.reload();
      // Straight into enrolment: a node that exists but is not enrolled does
      // nothing, so the next step is offered rather than waited for.
      await issueToken(created);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (node: Node): Promise<void> => {
    try {
      await api(`/nodes/${node.id}/revoke`, { method: 'POST' });
      toast.success('Credential revoked', `${node.name} has to enrol again.`);
      nodes.reload();
    } catch (error) {
      toast.error('Could not revoke', error instanceof ApiError ? error.message : 'Unexpected error.');
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/nodes/${deleting.id}`, { method: 'DELETE' });
      toast.success('Node deleted', deleting.name);
      setDeleting(null);
      nodes.reload();
    } catch (error) {
      toast.error('Could not delete node', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<Node>> = [
    {
      id: 'name',
      header: 'Node',
      sortValue: (row) => row.name,
      cell: (row) => (
        <div>
          <div style={{ fontWeight: 'var(--font-weight-medium)' }}>{row.name}</div>
          <div className="scp-hint scp-mono">{row.hostname ?? 'hostname not reported'}</div>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status,
      cell: (row) => (
        <HealthIndicator
          state={STATE[row.status].tone === 'success' ? 'success' : STATE[row.status].tone === 'warning' ? 'warning' : STATE[row.status].tone === 'danger' ? 'danger' : 'neutral'}
          label={STATE[row.status].label}
        />
      ),
    },
    {
      id: 'config',
      header: 'Configuration',
      cell: (row) =>
        !row.enrolled ? (
          <span className="scp-muted">—</span>
        ) : row.configuration.inSync ? (
          <StatusBadge tone="success">In sync</StatusBadge>
        ) : row.configuration.drift ? (
          <StatusBadge tone="warning">Drift</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Not reported</StatusBadge>
        ),
    },
    {
      id: 'seen',
      header: 'Last contact',
      sortValue: (row) => row.lastSeenAt ?? '',
      cell: (row) => <span className="scp-numeric scp-hint">{formatDateTime(row.lastSeenAt)}</span>,
    },
    {
      id: 'versions',
      header: 'Squid / agent',
      cell: (row) => (
        <span className="scp-mono scp-hint">
          {row.squidVersion ?? '—'} / {row.agentVersion ?? '—'}
        </span>
      ),
    },
  ];

  const summary = nodes.data?.summary;

  return (
    <Page width="wide">
      <PageHeader
        title="Proxy nodes"
        description="The Squid instances this control plane manages. Each node runs an agent that pulls its configuration, so the control plane never needs a route into the proxy network."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setForm({ name: '', description: '', hostname: '', adapterId: adapters[0]?.id ?? 'squid-6-debian' });
              }}
            >
              Add node
            </Button>
          ) : undefined
        }
      />

      {summary && (nodes.data?.items.length ?? 0) > 0 ? (
        <div className="scp-grid">
          <MetricCard label="Nodes" value={nodes.data?.items.length ?? 0} hint={`${summary.enrolled} enrolled`} />
          <MetricCard label="In sync" value={summary.inSync} hint="Running the current configuration" />
          <MetricCard
            label="Configuration drift"
            value={summary.drifted}
            hint={summary.drifted > 0 ? 'These nodes run something else' : 'No drift detected'}
          />
          <MetricCard
            label="Unreachable"
            value={summary.unreachable}
            hint={summary.unreachable > 0 ? 'No contact for more than three minutes' : 'All enrolled nodes reporting'}
          />
        </div>
      ) : null}

      {summary && summary.drifted > 0 ? (
        <InlineAlert tone="warning" title="Some nodes are not running the current configuration">
          Their agent reported a different configuration hash than the control plane would send. Check the node detail
          for the last apply result.
        </InlineAlert>
      ) : null}

      <Card flush>
        <DataTable
          columns={columns}
          rows={nodes.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Proxy nodes"
          loading={nodes.loading}
          error={nodes.error}
          onRetry={nodes.reload}
          onRowClick={setDetail}
          empty={{
            icon: 'server',
            title: 'No proxy nodes yet',
            description:
              'Add a node here, then run the agent on the machine that should serve as the proxy. It enrols itself with a one-time token and starts pulling configuration.',
            ...(canManage
              ? {
                  action: (
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() =>
                        setForm({ name: '', description: '', hostname: '', adapterId: adapters[0]?.id ?? 'squid-6-debian' })
                      }
                    >
                      Add the first node
                    </Button>
                  ),
                }
              : {}),
          }}
          rowActions={
            canManage
              ? (row) => (
                  <>
                    <IconButton
                      label={`Issue an enrolment token for ${row.name}`}
                      icon="key"
                      onClick={() => void issueToken(row)}
                    />
                    <IconButton label={`Delete ${row.name}`} icon="trash" onClick={() => setDeleting(row)} />
                  </>
                )
              : undefined
          }
        />
      </Card>

      {/* --- add node --- */}
      <Drawer
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title="Add proxy node"
        description="Declare the node here first. It becomes active once its agent enrols with the token issued in the next step."
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void createNode()}>
              Add and issue token
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not add the node">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <Input
              label="Name"
              value={form.name}
              hint="How this node appears everywhere in the control plane, for example proxy-de-01."
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Textarea
              label="Description"
              optional
              rows={2}
              value={form.description}
              hint="Site, purpose or owner - whatever the next operator needs to know."
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
            <Input
              label="Hostname"
              optional
              value={form.hostname}
              hint="Informational. The agent reports the real hostname when it enrols."
              onChange={(event) => setForm({ ...form, hostname: event.target.value })}
            />
            <Select
              label="Squid version"
              value={form.adapterId}
              options={adapters.map((adapter) => ({ value: adapter.id, label: `${adapter.displayName} — ${adapter.supports}` }))}
              hint="Decides helper paths and directive spelling in the generated configuration."
              onChange={(event) => setForm({ ...form, adapterId: event.target.value })}
            />
          </>
        ) : null}
      </Drawer>

      {/* --- enrolment instructions --- */}
      <Dialog
        open={Boolean(enrollment)}
        onClose={() => setEnrollment(null)}
        title={`Enrol ${enrollment?.node.name ?? ''}`}
        actions={<Button variant="primary" onClick={() => setEnrollment(null)}>Done</Button>}
      >
        <InlineAlert tone="warning" title="This token is shown once">
          {`It is single use and expires in ${enrollment?.expiresInMinutes ?? 60} minutes. If you lose it, issue a new one - nothing breaks.`}
        </InlineAlert>
        <p className="scp-secondary">
          Run this on the machine that should serve as the proxy. It needs Docker and network access to this control
          plane, nothing else.
        </p>
        <CodeViewer
          title="On the proxy host"
          code={[
            `export SCP_API_URL=${window.location.origin}`,
            `export SCP_ENROLLMENT_TOKEN=${enrollment?.token ?? ''}`,
            '',
            'docker compose -f deployments/agent/compose.yml up -d',
          ].join('\n')}
        />
        <p className="scp-hint">
          The node appears here within a minute of the agent starting. Remove the token from the environment
          afterwards; the agent stores its own credential.
        </p>
      </Dialog>

      {/* --- node detail --- */}
      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name ?? ''}
        description={detail?.description ?? undefined}
        size="wide"
        footer={
          canManage && detail ? (
            <>
              <Button onClick={() => void revoke(detail)}>Revoke credential</Button>
              <Button variant="primary" icon="key" onClick={() => void issueToken(detail)}>
                Issue enrolment token
              </Button>
            </>
          ) : undefined
        }
      >
        {detail ? (
          <>
            {detail.lastError ? (
              <InlineAlert tone="danger" title="The last configuration apply failed">
                {detail.lastError}
              </InlineAlert>
            ) : null}
            {!detail.enrolled ? (
              <InlineAlert tone="info" title="Not enrolled yet">
                This node exists in the control plane but no agent has claimed it. Issue an enrolment token and run the
                agent on the proxy host.
              </InlineAlert>
            ) : null}
            {detail.configuration.drift ? (
              <InlineAlert tone="warning" title="Configuration drift">
                The node reports a different configuration than the control plane would send. It will converge on the
                next poll unless applying keeps failing.
              </InlineAlert>
            ) : null}

            {/* The group decides which listeners this node serves, so it is
                changed here rather than on a separate screen. */}
            <Select
              label="Node group"
              value={detail.group?.id ?? ''}
              disabled={movingGroup || !canManage}
              hint="Listeners and scoped rules follow the group. Moving a node changes what it serves on the next poll."
              options={[
                { value: '', label: 'Unassigned' },
                ...(nodeGroups.data?.items ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => void moveToGroup(detail, event.target.value || null)}
            />

            <DescriptionList
              items={[
                { term: 'Status', description: <StatusBadge tone={STATE[detail.status].tone}>{STATE[detail.status].label}</StatusBadge> },
                { term: 'Hostname', description: <span className="scp-mono">{detail.hostname ?? '—'}</span> },
                { term: 'Squid adapter', description: <span className="scp-mono">{detail.adapterId}</span> },
                { term: 'Squid version', description: <span className="scp-mono">{detail.squidVersion ?? '—'}</span> },
                { term: 'Agent version', description: <span className="scp-mono">{detail.agentVersion ?? '—'}</span> },
                { term: 'Enrolled', description: formatDateTime(detail.enrolledAt) },
                { term: 'Last contact', description: formatDateTime(detail.lastSeenAt) },
                { term: 'Last apply', description: `${detail.apply.result ?? '—'}${detail.apply.at ? ` · ${formatDateTime(detail.apply.at)}` : ''}` },
                {
                  term: 'Configuration',
                  description: detail.configuration.inSync ? (
                    <StatusBadge tone="success">In sync</StatusBadge>
                  ) : detail.configuration.drift ? (
                    <StatusBadge tone="warning">Drift</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">Not reported</StatusBadge>
                  ),
                },
                {
                  term: 'Reported hash',
                  description: <span className="scp-mono scp-hint">{detail.configuration.reportedHash?.slice(0, 16) ?? '—'}</span>,
                },
                {
                  term: 'Current hash',
                  description: <span className="scp-mono scp-hint">{detail.configuration.currentHash.slice(0, 16)}</span>,
                },
              ]}
            />
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? ''}?`}
        consequence={
          'The node stops receiving configuration. Squid keeps running on that host with whatever it last applied until someone stops it there.\n\nThis action cannot be undone.'
        }
        affected={deleting?.hostname ? [deleting.hostname] : []}
        confirmWord="delete"
        confirmLabel="Delete node"
        loading={busy}
      />
    </Page>
  );
}
