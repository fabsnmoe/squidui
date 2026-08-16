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
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';

interface Network {
  id: string;
  name: string;
  description: string | null;
  cidrs: string[];
}

export function NetworksPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const networks = useQuery<{ items: Network[] }>((signal) => api('/networks', { signal }));
  const [form, setForm] = useState<{ id: string | null; name: string; description: string; cidrs: string } | null>(null);
  const [deleting, setDeleting] = useState<Network | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('POLICY_MANAGE');

  const columns: Array<Column<Network>> = [
    {
      id: 'name',
      header: 'Network',
      sortValue: (row) => row.name,
      cell: (row) => (
        <div>
          <div style={{ fontWeight: 'var(--font-weight-medium)' }}>{row.name}</div>
          {row.description ? <div className="scp-hint">{row.description}</div> : null}
        </div>
      ),
    },
    {
      id: 'cidrs',
      header: 'Ranges',
      cell: (row) => (
        <div className="scp-row scp-row-wrap">
          {row.cidrs.map((cidr) => (
            <StatusBadge key={cidr}>{cidr}</StatusBadge>
          ))}
        </div>
      ),
    },
  ];

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name,
      description: form.description || null,
      cidrs: form.cidrs.split(/[\s,]+/).filter(Boolean),
    };
    try {
      if (form.id) await api(`/networks/${form.id}`, { method: 'PATCH', body });
      else await api('/networks', { method: 'POST', body });
      toast.success(form.id ? 'Network updated' : 'Network created', form.name);
      setForm(null);
      networks.reload();
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
      await api(`/networks/${deleting.id}`, { method: 'DELETE' });
      toast.success('Network deleted', deleting.name);
      setDeleting(null);
      networks.reload();
    } catch (error) {
      toast.error('Could not delete network', error instanceof ApiError ? error.message : 'Unexpected error.');
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Networks"
        description="Named address ranges that access rules use as their source. Naming them keeps rules readable and lets one change apply everywhere."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => { setFormError(null); setForm({ id: null, name: '', description: '', cidrs: '' }); }}
            >
              Create network
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        <DataTable
          columns={columns}
          rows={networks.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Networks"
          loading={networks.loading}
          error={networks.error}
          onRetry={networks.reload}
          empty={{
            icon: 'network',
            title: 'No networks defined',
            description: 'Define the client networks that should be distinguishable in your access rules.',
          }}
          rowActions={
            canManage
              ? (row) => (
                  <>
                    <IconButton
                      label={`Edit ${row.name}`}
                      icon="edit"
                      onClick={() =>
                        setForm({
                          id: row.id,
                          name: row.name,
                          description: row.description ?? '',
                          cidrs: row.cidrs.join(' '),
                        })
                      }
                    />
                    <IconButton label={`Delete ${row.name}`} icon="trash" onClick={() => setDeleting(row)} />
                  </>
                )
              : undefined
          }
        />
      </Card>

      <Drawer
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? `Edit ${form.name}` : 'Create network'}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {form?.id ? 'Save changes' : 'Create network'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Textarea
              label="Description"
              optional
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
            <Textarea
              label="Address ranges"
              rows={4}
              value={form.cidrs}
              hint="One CIDR per line or space separated, IPv4 and IPv6, e.g. 10.20.0.0/24 or 2001:db8::/32"
              onChange={(event) => setForm({ ...form, cidrs: event.target.value })}
            />
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? ''}?`}
        consequence={'Access rules that use this network as their source can no longer be compiled until they are updated.\n\nThis action cannot be undone.'}
        affected={deleting?.cidrs ?? []}
        confirmWord="delete"
        confirmLabel="Delete network"
        loading={busy}
      />
    </Page>
  );
}
