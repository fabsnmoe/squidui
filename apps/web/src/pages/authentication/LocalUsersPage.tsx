import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  DataTable,
  Drawer,
  FilterBar,
  IconButton,
  InlineAlert,
  Input,
  Page,
  PageHeader,
  PasswordInput,
  SearchInput,
  Select,
  StatusBadge,
  Textarea,
  ConfirmDialog,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';
import { formatDateTime } from '../../lib/display.js';

/**
 * Authentication -> Local users (PLAN.md 9.11).
 *
 * A stored password is never rendered, not even masked from the server: the
 * form offers "replace password" instead (PRODUCT.md section 16).
 */

interface ProxyUser {
  id: string;
  username: string;
  displayName: string | null;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  hasPassword: boolean;
  groups: Array<{ id: string; name: string }>;
  passwordUpdatedAt: string | null;
  updatedAt: string;
}

interface ProxyGroup {
  id: string;
  name: string;
  source: 'LOCAL' | 'EXTERNAL' | 'LOGICAL';
}

interface EditorState {
  open: boolean;
  user: ProxyUser | null;
  username: string;
  displayName: string;
  description: string;
  status: 'ACTIVE' | 'DISABLED';
  password: string;
  groupIds: string[];
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  user: null,
  username: '',
  displayName: '',
  description: '',
  status: 'ACTIVE',
  password: '',
  groupIds: [],
};

export function LocalUsersPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [passwordFor, setPasswordFor] = useState<ProxyUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleting, setDeleting] = useState<ProxyUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const users = useQuery<{ items: ProxyUser[] }>(
    (signal) => api('/proxy-users', { signal, query: { search: search || undefined, status: status || undefined } }),
    [search, status],
  );
  const groups = useQuery<{ items: ProxyGroup[] }>((signal) => api('/proxy-groups', { signal, query: { source: 'LOCAL' } }));

  const canCreate = can('PROXY_USER_CREATE');
  const canUpdate = can('PROXY_USER_UPDATE');
  const canDelete = can('PROXY_USER_DELETE');
  const canResetPassword = can('PROXY_USER_PASSWORD_RESET');

  const columns = useMemo<Array<Column<ProxyUser>>>(
    () => [
      {
        id: 'username',
        header: 'Username',
        sortValue: (row) => row.username,
        cell: (row) => (
          <div>
            <div className="scp-mono" style={{ fontSize: 'var(--font-size-base)' }}>
              {row.username}
            </div>
            {row.displayName ? <div className="scp-hint">{row.displayName}</div> : null}
          </div>
        ),
      },
      {
        id: 'groups',
        header: 'Groups',
        cell: (row) =>
          row.groups.length === 0 ? (
            <span className="scp-muted">None</span>
          ) : (
            <div className="scp-row scp-row-wrap">
              {row.groups.map((group) => (
                <StatusBadge key={group.id}>{group.name}</StatusBadge>
              ))}
            </div>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (row) => row.status,
        cell: (row) => (
          <StatusBadge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>
            {row.status === 'ACTIVE' ? 'Active' : 'Disabled'}
          </StatusBadge>
        ),
      },
      {
        id: 'password',
        header: 'Password',
        cell: (row) =>
          row.hasPassword ? (
            <span className="scp-muted">Set</span>
          ) : (
            <StatusBadge tone="warning">Not set</StatusBadge>
          ),
      },
      {
        id: 'changed',
        header: 'Last changed',
        sortValue: (row) => row.updatedAt,
        cell: (row) => <span className="scp-numeric">{formatDateTime(row.updatedAt)}</span>,
      },
    ],
    [],
  );

  const openCreate = (): void => {
    setFormError(null);
    setEditor({ ...EMPTY_EDITOR, open: true });
  };

  const openEdit = (user: ProxyUser): void => {
    setFormError(null);
    setEditor({
      open: true,
      user,
      username: user.username,
      displayName: user.displayName ?? '',
      description: user.description ?? '',
      status: user.status,
      password: '',
      groupIds: user.groups.map((group) => group.id),
    });
  };

  const saveUser = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      if (editor.user) {
        await api(`/proxy-users/${editor.user.id}`, {
          method: 'PATCH',
          body: {
            displayName: editor.displayName || null,
            description: editor.description || null,
            status: editor.status,
            groupIds: editor.groupIds,
          },
        });
        toast.success('User updated', editor.username);
      } else {
        await api('/proxy-users', {
          method: 'POST',
          body: {
            username: editor.username,
            displayName: editor.displayName || null,
            description: editor.description || null,
            status: editor.status,
            groupIds: editor.groupIds,
            ...(editor.password ? { password: editor.password } : {}),
          },
        });
        toast.success('User created', editor.username);
      }
      setEditor(EMPTY_EDITOR);
      users.reload();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const replacePassword = async (): Promise<void> => {
    if (!passwordFor) return;
    setBusy(true);
    setFormError(null);
    try {
      await api(`/proxy-users/${passwordFor.id}/password`, { method: 'POST', body: { password: newPassword } });
      toast.success('Password replaced', passwordFor.username);
      setPasswordFor(null);
      setNewPassword('');
      users.reload();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeUser = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/proxy-users/${deleting.id}`, { method: 'DELETE' });
      toast.success('User deleted', deleting.username);
      setDeleting(null);
      users.reload();
    } catch (error) {
      toast.error('Could not delete user', describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Local proxy users"
        description="Accounts that authenticate clients against Squid. These are not control plane accounts and cannot sign in to this web UI."
        actions={
          canCreate ? (
            <Button variant="primary" icon="plus" onClick={openCreate}>
              Create user
            </Button>
          ) : undefined
        }
      />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search username or display name" />
        <div style={{ width: 180 }}>
          <Select
            label="Status"
            value={status}
            placeholder="All statuses"
            options={[
              { value: 'ACTIVE', label: 'Active' },
              { value: 'DISABLED', label: 'Disabled' },
            ]}
            onChange={(event) => setStatus(event.target.value)}
          />
        </div>
      </FilterBar>

      <Card flush>
        <DataTable
          columns={columns}
          rows={users.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Local proxy users"
          loading={users.loading}
          error={users.error}
          onRetry={users.reload}
          empty={{
            icon: 'users',
            title: search || status ? 'No user matches the filter' : 'No local proxy users yet',
            description:
              search || status
                ? 'Adjust the search or status filter.'
                : 'Local users are useful for emergency access, service accounts and lab users while regular staff authenticate through LDAP.',
            ...(canCreate && !search && !status
              ? {
                  action: (
                    <Button variant="primary" icon="plus" onClick={openCreate}>
                      Create the first user
                    </Button>
                  ),
                }
              : {}),
          }}
          onRowClick={canUpdate ? openEdit : undefined}
          rowActions={(row) => (
            <>
              {canResetPassword ? (
                <IconButton
                  label={`Replace password of ${row.username}`}
                  icon="key"
                  onClick={() => {
                    setFormError(null);
                    setNewPassword('');
                    setPasswordFor(row);
                  }}
                />
              ) : null}
              {canUpdate ? (
                <IconButton label={`Edit ${row.username}`} icon="edit" onClick={() => openEdit(row)} />
              ) : null}
              {canDelete ? (
                <IconButton label={`Delete ${row.username}`} icon="trash" onClick={() => setDeleting(row)} />
              ) : null}
            </>
          )}
        />
      </Card>

      <Drawer
        open={editor.open}
        onClose={() => setEditor(EMPTY_EDITOR)}
        title={editor.user ? `Edit ${editor.user.username}` : 'Create local proxy user'}
        description={
          editor.user
            ? 'The username cannot be changed, because generated proxy configuration references it.'
            : 'The user can authenticate against the proxy as soon as a password is set.'
        }
        footer={
          <>
            <Button onClick={() => setEditor(EMPTY_EDITOR)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void saveUser()}>
              {editor.user ? 'Save changes' : 'Create user'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}

        <Input
          label="Username"
          value={editor.username}
          disabled={Boolean(editor.user)}
          hint="Letters, digits, dot, underscore, at sign and hyphen."
          onChange={(event) => setEditor((state) => ({ ...state, username: event.target.value }))}
        />
        <Input
          label="Display name"
          optional
          value={editor.displayName}
          onChange={(event) => setEditor((state) => ({ ...state, displayName: event.target.value }))}
        />
        <Textarea
          label="Description"
          optional
          rows={2}
          value={editor.description}
          hint="What this account is for, for example “emergency access” or “CI runner”."
          onChange={(event) => setEditor((state) => ({ ...state, description: event.target.value }))}
        />
        <Select
          label="Status"
          value={editor.status}
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'DISABLED', label: 'Disabled — cannot authenticate' },
          ]}
          onChange={(event) => setEditor((state) => ({ ...state, status: event.target.value as 'ACTIVE' | 'DISABLED' }))}
        />

        {editor.user ? (
          <PasswordInput label="Password" existing />
        ) : (
          <PasswordInput
            label="Password"
            optional
            value={editor.password}
            hint="At least 12 characters. Stored as a crypt(3) hash the Squid helper can verify; it is never displayed again."
            onChange={(event) => setEditor((state) => ({ ...state, password: event.target.value }))}
          />
        )}

        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="scp-label" style={{ marginBottom: 'var(--space-2)' }}>
            Groups
          </legend>
          <div className="scp-stack" style={{ gap: 'var(--space-2)' }}>
            {(groups.data?.items ?? []).length === 0 ? (
              <p className="scp-hint">No local groups exist yet. Create them under Authentication → Groups.</p>
            ) : (
              (groups.data?.items ?? []).map((group) => (
                <label key={group.id} className="scp-checkbox">
                  <input
                    type="checkbox"
                    checked={editor.groupIds.includes(group.id)}
                    onChange={(event) =>
                      setEditor((state) => ({
                        ...state,
                        groupIds: event.target.checked
                          ? [...state.groupIds, group.id]
                          : state.groupIds.filter((id) => id !== group.id),
                      }))
                    }
                  />
                  <span>{group.name}</span>
                </label>
              ))
            )}
          </div>
        </fieldset>
      </Drawer>

      <Drawer
        open={Boolean(passwordFor)}
        onClose={() => setPasswordFor(null)}
        title={`Replace password of ${passwordFor?.username ?? ''}`}
        description="The current password cannot be read. Setting a new one replaces it immediately."
        footer={
          <>
            <Button onClick={() => setPasswordFor(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void replacePassword()}>
              Replace password
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not replace password">{formError}</InlineAlert> : null}
        <PasswordInput
          label="New password"
          value={newPassword}
          hint="At least 12 characters."
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeUser()}
        title={`Delete ${deleting?.username ?? ''}?`}
        consequence={
          'This proxy user is removed from the generated password file on the next deployment and can no longer authenticate.\n\nThis action cannot be undone.'
        }
        affected={deleting?.groups.map((group) => `Group membership: ${group.name}`) ?? []}
        confirmWord="delete"
        confirmLabel="Delete user"
        loading={busy}
      />
    </Page>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const violations = Array.isArray(error.details)
      ? (error.details as Array<{ message?: string }>).map((entry) => entry.message).filter(Boolean)
      : [];
    return violations.length > 0 ? `${error.message} ${violations.join(' ')}` : error.message;
  }
  return 'Unexpected error.';
}
