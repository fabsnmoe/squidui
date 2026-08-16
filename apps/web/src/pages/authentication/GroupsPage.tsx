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
  Textarea,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';

/**
 * Authentication -> Groups (PLAN.md 9.12).
 *
 * Supports local groups, external (LDAP) groups and logical groups that unify
 * both under one name so policies never depend on where a group comes from
 * (PRODUCT.md section 18).
 */

interface Group {
  id: string;
  name: string;
  description: string | null;
  source: 'LOCAL' | 'EXTERNAL' | 'LOGICAL';
  providerKey: string | null;
  externalId: string | null;
  memberCount: number;
  members: Array<{ id: string; name: string; source: string; providerKey: string | null }>;
}

interface GroupForm {
  id: string | null;
  name: string;
  description: string;
  source: Group['source'];
  providerKey: string;
  externalId: string;
  memberGroupIds: string[];
}

const EMPTY_FORM: GroupForm = {
  id: null,
  name: '',
  description: '',
  source: 'LOCAL',
  providerKey: '',
  externalId: '',
  memberGroupIds: [],
};

const SOURCE_TONE = { LOCAL: 'accent', EXTERNAL: 'info', LOGICAL: 'success' } as const;

export function ProxyGroupsPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const groups = useQuery<{ items: Group[] }>((signal) => api('/proxy-groups', { signal }));
  const providers = useQuery<{ providers: Array<{ key: string; name: string; type: string }> }>((signal) =>
    api('/auth-providers', { signal }),
  );

  const [form, setForm] = useState<GroupForm | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('PROXY_GROUP_MANAGE');
  const concreteGroups = (groups.data?.items ?? []).filter((group) => group.source !== 'LOGICAL');

  const columns: Array<Column<Group>> = [
    {
      id: 'name',
      header: 'Group',
      sortValue: (row) => row.name,
      cell: (row) => (
        <div>
          <div style={{ fontWeight: 'var(--font-weight-medium)' }}>{row.name}</div>
          {row.description ? <div className="scp-hint">{row.description}</div> : null}
        </div>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      sortValue: (row) => row.source,
      cell: (row) => (
        <StatusBadge tone={SOURCE_TONE[row.source]}>
          {row.source === 'EXTERNAL' ? `LDAP · ${row.providerKey ?? '?'}` : row.source.toLowerCase()}
        </StatusBadge>
      ),
    },
    {
      id: 'members',
      header: 'Members',
      align: 'right',
      sortValue: (row) => (row.source === 'LOGICAL' ? row.members.length : row.memberCount),
      cell: (row) =>
        row.source === 'LOGICAL' ? (
          <span className="scp-numeric">{row.members.length} groups</span>
        ) : row.source === 'EXTERNAL' ? (
          <span className="scp-muted">Resolved by the directory</span>
        ) : (
          <span className="scp-numeric">{row.memberCount} users</span>
        ),
    },
  ];

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      if (form.id) {
        await api(`/proxy-groups/${form.id}`, {
          method: 'PATCH',
          body: {
            name: form.name,
            description: form.description || null,
            externalId: form.externalId || null,
            memberGroupIds: form.memberGroupIds,
          },
        });
        toast.success('Group updated', form.name);
      } else {
        await api('/proxy-groups', {
          method: 'POST',
          body: {
            name: form.name,
            description: form.description || null,
            source: form.source,
            providerKey: form.source === 'EXTERNAL' ? form.providerKey : null,
            externalId: form.externalId || null,
            memberGroupIds: form.memberGroupIds,
          },
        });
        toast.success('Group created', form.name);
      }
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
      await api(`/proxy-groups/${deleting.id}`, { method: 'DELETE' });
      toast.success('Group deleted', deleting.name);
      setDeleting(null);
      groups.reload();
    } catch (error) {
      toast.error('Could not delete group', error instanceof ApiError ? error.message : 'Unexpected error.');
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Proxy groups"
        description="Groups used by access rules. A logical group lets one rule cover local and directory groups at once."
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => { setFormError(null); setForm({ ...EMPTY_FORM }); }}>
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
          caption="Proxy groups"
          loading={groups.loading}
          error={groups.error}
          onRetry={groups.reload}
          empty={{
            icon: 'group',
            title: 'No groups yet',
            description:
              'Groups keep access rules readable: a rule references "Developers" instead of a list of usernames.',
            ...(canManage
              ? {
                  action: (
                    <Button variant="primary" icon="plus" onClick={() => setForm({ ...EMPTY_FORM })}>
                      Create the first group
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
                      label={`Edit ${row.name}`}
                      icon="edit"
                      onClick={() => {
                        setFormError(null);
                        setForm({
                          id: row.id,
                          name: row.name,
                          description: row.description ?? '',
                          source: row.source,
                          providerKey: row.providerKey ?? '',
                          externalId: row.externalId ?? '',
                          memberGroupIds: row.members.map((member) => member.id),
                        });
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
        title={form?.id ? `Edit ${form.name}` : 'Create group'}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {form?.id ? 'Save changes' : 'Create group'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <Select
              label="Type"
              value={form.source}
              disabled={Boolean(form.id)}
              options={[
                { value: 'LOCAL', label: 'Local — members are local proxy users' },
                { value: 'EXTERNAL', label: 'External — a group in a directory' },
                { value: 'LOGICAL', label: 'Logical — unifies other groups under one name' },
              ]}
              onChange={(event) => setForm({ ...form, source: event.target.value as Group['source'] })}
            />
            <Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Textarea
              label="Description"
              optional
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />

            {form.source === 'EXTERNAL' ? (
              <>
                <Select
                  label="Provider"
                  value={form.providerKey}
                  placeholder="Select a directory"
                  options={(providers.data?.providers ?? [])
                    .filter((provider) => provider.type === 'LDAP')
                    .map((provider) => ({ value: provider.key, label: provider.name }))}
                  onChange={(event) => setForm({ ...form, providerKey: event.target.value })}
                />
                <Input
                  label="Directory identifier"
                  optional
                  value={form.externalId}
                  hint="Distinguished name, for documentation and for the generated external ACL."
                  onChange={(event) => setForm({ ...form, externalId: event.target.value })}
                />
              </>
            ) : null}

            {form.source === 'LOGICAL' ? (
              <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend className="scp-label" style={{ marginBottom: 'var(--space-2)' }}>
                  Member groups
                </legend>
                <div className="scp-stack" style={{ gap: 'var(--space-2)' }}>
                  {concreteGroups.length === 0 ? (
                    <p className="scp-hint">Create a local or external group first.</p>
                  ) : (
                    concreteGroups.map((group) => (
                      <label key={group.id} className="scp-checkbox">
                        <input
                          type="checkbox"
                          checked={form.memberGroupIds.includes(group.id)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              memberGroupIds: event.target.checked
                                ? [...form.memberGroupIds, group.id]
                                : form.memberGroupIds.filter((id) => id !== group.id),
                            })
                          }
                        />
                        <span>
                          {group.name} <span className="scp-hint">({group.source.toLowerCase()})</span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </fieldset>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleting?.name ?? ''}?`}
        consequence={
          'Access rules that reference this group will be rejected until they are updated. Group memberships of local users are removed.\n\nThis action cannot be undone.'
        }
        confirmWord="delete"
        confirmLabel="Delete group"
        loading={busy}
      />
    </Page>
  );
}
