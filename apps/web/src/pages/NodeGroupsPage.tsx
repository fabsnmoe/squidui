import { useState } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Drawer,
  IconButton,
  InlineAlert,
  Input,
  Page,
  PageHeader,
  StatusBadge,
  Textarea,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { useSession } from '../lib/session.js';

/**
 * Node groups (ADR 0003).
 *
 * A group is the middle level of the hierarchy: global configuration applies
 * everywhere, a group carries the things that differ per site — its listeners
 * and, where a site genuinely needs it, scoped access rules.
 */

interface NodeGroup {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  node_count: number;
  listener_count: number;
}

const emptyGroup = (): NodeGroup => ({
  id: '',
  name: '',
  description: null,
  is_default: false,
  node_count: 0,
  listener_count: 0,
});

export function NodeGroupsPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const groups = useQuery<{ items: NodeGroup[] }>((signal) => api('/node-groups', { signal }));
  const [form, setForm] = useState<NodeGroup | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<NodeGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('NODE_MANAGE');

  const columns: Array<Column<NodeGroup>> = [
    {
      id: 'name',
      header: 'Group',
      sortValue: (row) => row.name,
      cell: (row) => (
        <span className="scp-row">
          {row.name}
          {row.is_default ? <StatusBadge>Default</StatusBadge> : null}
        </span>
      ),
    },
    {
      id: 'description',
      header: 'Purpose',
      cell: (row) => row.description ?? <span className="scp-hint">No description</span>,
    },
    {
      id: 'nodes',
      header: 'Nodes',
      sortValue: (row) => row.node_count,
      cell: (row) => row.node_count,
    },
    {
      id: 'listeners',
      header: 'Own listeners',
      sortValue: (row) => row.listener_count,
      // Zero is not a problem: a group with no listeners of its own still
      // serves every listener assigned to all groups.
      cell: (row) => (row.listener_count === 0 ? <span className="scp-hint">Global only</span> : row.listener_count),
    },
  ];

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    const body = { name: form.name, description: form.description };
    try {
      if (creating) await api('/node-groups', { method: 'POST', body });
      else await api(`/node-groups/${form.id}`, { method: 'PATCH', body });
      toast.success(creating ? 'Node group created' : 'Node group updated', form.name);
      setForm(null);
      groups.reload();
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/node-groups/${deleting.id}`, { method: 'DELETE' });
      toast.success('Node group deleted', deleting.name);
      setDeleting(null);
      groups.reload();
    } catch (error) {
      toast.error('Could not delete group', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Node groups"
        description="Sites differ; security policy usually does not. A group holds what a site owns — its listeners and any rules scoped to it — while everything else stays global."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setCreating(true);
                setForm(emptyGroup());
              }}
            >
              Create group
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        <DataTable
          columns={columns}
          rows={groups.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Node groups"
          loading={groups.loading}
          error={groups.error}
          onRetry={groups.reload}
          empty={{
            icon: 'server',
            title: 'No node groups',
            description: 'Every node belongs to the default group until another one exists.',
          }}
          rowActions={
            canManage
              ? (row) => (
                  <>
                    <IconButton
                      label={`Edit ${row.name}`}
                      icon="edit"
                      onClick={() => {
                        setCreating(false);
                        setFormError(null);
                        setForm(row);
                      }}
                    />
                    {/* The default group is where an unassigned node lands, so it stays. */}
                    {row.is_default ? null : (
                      <IconButton label={`Delete ${row.name}`} icon="trash" onClick={() => setDeleting(row)} />
                    )}
                  </>
                )
              : undefined
          }
        />
      </Card>

      <Drawer
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={creating ? 'Create node group' : `Edit ${form?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {creating ? 'Create group' : 'Save changes'}
            </Button>
          </>
        }
      >
        {formError ? (
          <InlineAlert tone="danger" title="Could not save">
            {formError}
          </InlineAlert>
        ) : null}
        {form ? (
          <>
            <Input
              label="Name"
              value={form.name}
              hint="Usually a site or a role: Leipzig, Frankfurt, DMZ."
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Textarea
              label="Purpose"
              rows={3}
              value={form.description ?? ''}
              hint="What makes this group different from the others. The next operator reads this before changing anything."
              onChange={(event) => setForm({ ...form, description: event.target.value || null })}
            />
            {!creating && form.node_count > 0 ? (
              <InlineAlert tone="info" title={`${form.node_count} node(s) in this group`}>
                Changes to this group reach those nodes with the next deployment.
              </InlineAlert>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? ''}?`}
        consequence={'Listeners and scoped rules belonging to this group are removed with it.\n\nThis action cannot be undone.'}
        affected={
          deleting
            ? [`${deleting.listener_count} listener(s)`, `${deleting.node_count} node(s) must be moved first`]
            : []
        }
        confirmWord="delete"
        confirmLabel="Delete group"
        loading={busy}
      />
    </Page>
  );
}
