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

/**
 * Listener profiles (ADR 0003).
 *
 * A listener carries its own authentication mode, which is what lets a
 * corporate listener demanding credentials and a guest listener demanding none
 * run on the same node. Inherit follows the global default, so an installation
 * with a single proxy never has to think about any of this.
 */

type AuthMode = 'INHERIT' | 'DISABLED' | 'OPTIONAL' | 'REQUIRED';
type EffectiveMode = Exclude<AuthMode, 'INHERIT'>;

interface ListenerProfile {
  id: string;
  name: string;
  address: string;
  port: number;
  mode: 'FORWARD' | 'INTERCEPT';
  enabled: boolean;
  authentication_mode: AuthMode;
  group_id: string | null;
  group_name: string | null;
}

interface NodeGroup {
  id: string;
  name: string;
}

const WILDCARD = new Set(['0.0.0.0', '::']);

const MODE_TONE: Record<EffectiveMode, 'success' | 'warning' | 'neutral'> = {
  REQUIRED: 'success',
  OPTIONAL: 'warning',
  DISABLED: 'neutral',
};

const emptyProfile = (): ListenerProfile => ({
  id: '',
  name: '',
  address: '0.0.0.0',
  port: 3128,
  mode: 'FORWARD',
  enabled: true,
  authentication_mode: 'INHERIT',
  group_id: null,
  group_name: null,
});

export function ListenersPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const profiles = useQuery<{ items: ListenerProfile[]; globalDefault: EffectiveMode }>((signal) =>
    api('/listener-profiles', { signal }),
  );
  const groups = useQuery<{ items: NodeGroup[] }>((signal) => api('/node-groups', { signal }));
  const [form, setForm] = useState<ListenerProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ListenerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('LISTENER_MANAGE');
  const globalDefault = profiles.data?.globalDefault ?? 'DISABLED';

  /** What the listener actually enforces, which is the only thing that matters. */
  const effective = (row: Pick<ListenerProfile, 'authentication_mode'>): EffectiveMode =>
    row.authentication_mode === 'INHERIT' ? globalDefault : row.authentication_mode;

  const columns: Array<Column<ListenerProfile>> = [
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
    {
      id: 'authentication',
      header: 'Authentication',
      cell: (row) => (
        <span className="scp-row">
          <StatusBadge tone={MODE_TONE[effective(row)]}>{effective(row)}</StatusBadge>
          {row.authentication_mode === 'INHERIT' ? <span className="scp-hint">inherited</span> : null}
        </span>
      ),
    },
    {
      id: 'assignment',
      header: 'Assigned to',
      cell: (row) => row.group_name ?? <span className="scp-hint">All node groups</span>,
    },
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
      authenticationMode: form.authentication_mode,
      groupId: form.group_id,
    };
    try {
      if (creating) await api('/listener-profiles', { method: 'POST', body });
      else await api(`/listener-profiles/${form.id}`, { method: 'PATCH', body });
      toast.success(creating ? 'Listener created' : 'Listener updated', form.name);
      setForm(null);
      profiles.reload();
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
      await api(`/listener-profiles/${deleting.id}`, { method: 'DELETE' });
      toast.success('Listener deleted', deleting.name);
      setDeleting(null);
      profiles.reload();
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
        description="Where Squid accepts client connections, and whether it asks those clients for credentials. Two listeners on one node can answer differently: a corporate port that requires sign-in, a guest port that does not."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setCreating(true);
                setForm(emptyProfile());
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
          rows={profiles.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Listener profiles"
          loading={profiles.loading}
          error={profiles.error}
          onRetry={profiles.reload}
          empty={{
            icon: 'listener',
            title: 'No listeners configured',
            description: 'Squid will not accept traffic without at least one listener.',
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
        {formError ? (
          <InlineAlert tone="danger" title="Could not save">
            {formError}
          </InlineAlert>
        ) : null}
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
              label="Authentication"
              value={form.authentication_mode}
              hint={
                form.authentication_mode === 'INHERIT'
                  ? `Follows the global default, which is ${globalDefault} right now.`
                  : 'Overrides the global default for this listener only.'
              }
              options={[
                { value: 'INHERIT', label: `Inherit the global default (${globalDefault})` },
                { value: 'REQUIRED', label: 'Required — every client must sign in' },
                { value: 'OPTIONAL', label: 'Optional — credentials are used when offered' },
                { value: 'DISABLED', label: 'Disabled — no client is ever asked' },
              ]}
              onChange={(event) => setForm({ ...form, authentication_mode: event.target.value as AuthMode })}
            />
            {effective(form) === 'DISABLED' ? (
              <InlineAlert tone="warning" title="This listener never identifies its clients">
                Requests arriving here appear in the traffic log without a user, and rules that match on a user or
                group cannot apply to them. Make sure a rule covers this listener without an identity condition.
              </InlineAlert>
            ) : null}
            <Select
              label="Assigned to"
              value={form.group_id ?? ''}
              hint="A listener assigned to one group exists only on the nodes in that group."
              options={[
                { value: '', label: 'All node groups' },
                ...(groups.data?.items ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => setForm({ ...form, group_id: event.target.value || null })}
            />
            <Select
              label="Mode"
              value={form.mode}
              options={[
                { value: 'FORWARD', label: 'Forward proxy — clients are configured explicitly' },
                { value: 'INTERCEPT', label: 'Intercept — traffic is redirected transparently' },
              ]}
              onChange={(event) => setForm({ ...form, mode: event.target.value as ListenerProfile['mode'] })}
            />
            <Switch
              checked={form.enabled}
              label="Listener is enabled"
              onChange={(value) => setForm({ ...form, enabled: value })}
            />
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
