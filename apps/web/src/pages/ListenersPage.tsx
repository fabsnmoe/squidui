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
  Select,
  StatusBadge,
  Switch,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { useSession } from '../lib/session.js';

interface Listener {
  id: string;
  name: string;
  address: string;
  port: number;
  mode: 'FORWARD' | 'INTERCEPT';
  enabled: boolean;
}

const WILDCARD = new Set(['0.0.0.0', '::']);

export function ListenersPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const listeners = useQuery<{ items: Listener[] }>((signal) => api('/listeners', { signal }));
  const [form, setForm] = useState<Listener | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Listener | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('LISTENER_MANAGE');

  const columns: Array<Column<Listener>> = [
    { id: 'name', header: 'Listener', sortValue: (row) => row.name, cell: (row) => row.name },
    {
      id: 'bind',
      header: 'Bind address',
      cell: (row) => (
        <span className="scp-row">
          <span className="scp-mono">
            {row.address}:{row.port}
          </span>
          {WILDCARD.has(row.address) ? <StatusBadge tone="warning">All interfaces</StatusBadge> : null}
        </span>
      ),
    },
    { id: 'mode', header: 'Mode', cell: (row) => <StatusBadge>{row.mode}</StatusBadge> },
    {
      id: 'enabled',
      header: 'Enabled',
      cell: (row) => (
        <StatusBadge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Yes' : 'No'}</StatusBadge>
      ),
    },
  ];

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name,
      address: form.address,
      port: Number(form.port),
      mode: form.mode,
      enabled: form.enabled,
    };
    try {
      if (creating) await api('/listeners', { method: 'POST', body });
      else await api(`/listeners/${form.id}`, { method: 'PATCH', body });
      toast.success(creating ? 'Listener created' : 'Listener updated', form.name);
      setForm(null);
      listeners.reload();
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
      await api(`/listeners/${deleting.id}`, { method: 'DELETE' });
      toast.success('Listener deleted', deleting.name);
      setDeleting(null);
      listeners.reload();
    } catch (error) {
      toast.error('Could not delete listener', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Listeners"
        description="Where Squid accepts client connections. A listener bound to all interfaces is reachable from every network that can route to the node."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setCreating(true);
                setForm({ id: '', name: '', address: '0.0.0.0', port: 3128, mode: 'FORWARD', enabled: true });
              }}
            >
              Create listener
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        <DataTable
          columns={columns}
          rows={listeners.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Listeners"
          loading={listeners.loading}
          error={listeners.error}
          onRetry={listeners.reload}
          empty={{ icon: 'listener', title: 'No listeners configured', description: 'Squid will not accept traffic without at least one listener.' }}
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
        title={creating ? 'Create listener' : `Edit ${form?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {creating ? 'Create listener' : 'Save changes'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Input
              label="Bind address"
              value={form.address}
              hint="0.0.0.0 listens on every interface. Bind to a specific address to limit exposure."
              onChange={(event) => setForm({ ...form, address: event.target.value })}
            />
            {WILDCARD.has(form.address) ? (
              <InlineAlert tone="warning" title="Reachable from every routable network">
                Combined with disabled authentication and an allow-any policy this creates an open proxy. Firewall
                rules are then the only remaining control.
              </InlineAlert>
            ) : null}
            <Input
              label="Port"
              type="number"
              value={form.port}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            />
            <Select
              label="Mode"
              value={form.mode}
              options={[
                { value: 'FORWARD', label: 'Forward proxy — clients are configured explicitly' },
                { value: 'INTERCEPT', label: 'Intercept — traffic is redirected transparently' },
              ]}
              onChange={(event) => setForm({ ...form, mode: event.target.value as Listener['mode'] })}
            />
            <Switch checked={form.enabled} label="Listener is enabled" onChange={(value) => setForm({ ...form, enabled: value })} />
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? ''}?`}
        consequence={'Clients connecting to this address and port will be refused after the next deployment.\n\nThis action cannot be undone.'}
        affected={deleting ? [`${deleting.address}:${deleting.port}`] : []}
        confirmWord="delete"
        confirmLabel="Delete listener"
        loading={busy}
      />
    </Page>
  );
}
