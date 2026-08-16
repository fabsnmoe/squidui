import { useState } from 'react';
import type { AuthenticationProviderSummary } from '@scp/shared';
import {
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  Drawer,
  InlineAlert,
  Input,
  Page,
  PageHeader,
  PasswordInput,
  Skeleton,
  StatusBadge,
  Switch,
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';
import { ProviderHealthBadge } from '../../lib/display.js';

/** Authentication -> Providers (PLAN.md 9.13). */

interface ProviderRow extends AuthenticationProviderSummary {
  statistics: { users: number | null; groups: number | null } | null;
  server?: string;
}

interface TestResult {
  ok: boolean;
  summary: string;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
}

interface LdapForm {
  key: string;
  name: string;
  priority: number;
  enabled: boolean;
  uri: string;
  baseDn: string;
  userFilter: string;
  bindDn: string;
  bindPassword: string;
  startTls: boolean;
  tlsRejectUnauthorized: boolean;
  groupBaseDn: string;
  groupFilter: string;
}

const EMPTY_FORM: LdapForm = {
  key: '',
  name: '',
  priority: 20,
  enabled: false,
  uri: 'ldaps://ldap.example.internal',
  baseDn: 'ou=people,dc=example,dc=internal',
  userFilter: '(uid=%s)',
  bindDn: '',
  bindPassword: '',
  startTls: false,
  tlsRejectUnauthorized: true,
  groupBaseDn: '',
  groupFilter: '(&(objectClass=groupOfNames)(member=%u))',
};

export function ProvidersPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const providers = useQuery<{ providers: ProviderRow[] }>((signal) => api('/auth-providers', { signal }));

  const [form, setForm] = useState<LdapForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('AUTH_PROVIDER_MANAGE');
  const canTest = can('AUTH_PROVIDER_TEST');

  const runTest = async (provider: ProviderRow): Promise<void> => {
    setTesting(provider.id);
    try {
      const result = await api<TestResult>(`/auth-providers/${provider.id}/test`, { method: 'POST' });
      setResults((current) => ({ ...current, [provider.id]: result }));
      providers.reload();
    } catch (error) {
      toast.error('Connection test failed', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setTesting(null);
    }
  };

  const toggleEnabled = async (provider: ProviderRow, enabled: boolean): Promise<void> => {
    try {
      await api(`/auth-providers/${provider.id}`, { method: 'PATCH', body: { enabled } });
      toast.success(enabled ? 'Provider enabled' : 'Provider disabled', provider.name);
      providers.reload();
    } catch (error) {
      toast.error('Could not update provider', error instanceof ApiError ? error.message : 'Unexpected error.');
    }
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    const config = {
      uri: form.uri,
      baseDn: form.baseDn,
      userFilter: form.userFilter,
      bindDn: form.bindDn || null,
      startTls: form.startTls,
      tlsRejectUnauthorized: form.tlsRejectUnauthorized,
      groupBaseDn: form.groupBaseDn || null,
      groupFilter: form.groupFilter || null,
    };
    try {
      if (editingId) {
        await api(`/auth-providers/${editingId}`, {
          method: 'PATCH',
          body: {
            name: form.name,
            enabled: form.enabled,
            priority: form.priority,
            config,
            ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          },
        });
        toast.success('Provider updated', form.name);
      } else {
        await api('/auth-providers', {
          method: 'POST',
          body: {
            key: form.key,
            type: 'LDAP',
            name: form.name,
            enabled: form.enabled,
            priority: form.priority,
            config,
            ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          },
        });
        toast.success('Provider created', form.name);
      }
      setForm(null);
      setEditingId(null);
      providers.reload();
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
      await api(`/auth-providers/${deleting.id}`, { method: 'DELETE' });
      toast.success('Provider deleted', deleting.name);
      setDeleting(null);
      providers.reload();
    } catch (error) {
      toast.error('Could not delete provider', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Authentication providers"
        description="Providers are consulted in priority order and can be active at the same time. A failing LDAP directory never disables local accounts."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setEditingId(null);
                setForm({ ...EMPTY_FORM });
              }}
            >
              Add LDAP provider
            </Button>
          ) : undefined
        }
      />

      {providers.loading ? (
        <Card>
          <div className="scp-stack">
            <Skeleton width="30%" height={20} />
            <Skeleton height={80} />
          </div>
        </Card>
      ) : providers.error ? (
        <InlineAlert tone="danger" title="Providers could not be loaded">
          {providers.error.message}
        </InlineAlert>
      ) : (
        (providers.data?.providers ?? []).map((provider) => {
          const result = results[provider.id];
          return (
            <Card
              key={provider.id}
              title={provider.name}
              description={provider.type === 'LOCAL' ? 'Built-in local user store' : provider.server}
              actions={
                <>
                  {canTest ? (
                    <Button
                      icon="refresh"
                      loading={testing === provider.id}
                      onClick={() => void runTest(provider)}
                    >
                      Test connection
                    </Button>
                  ) : null}
                  {canManage && provider.type === 'LDAP' ? (
                    <>
                      <Button
                        icon="edit"
                        onClick={() => {
                          setFormError(null);
                          setEditingId(provider.id);
                          setForm({
                            ...EMPTY_FORM,
                            key: provider.key,
                            name: provider.name,
                            priority: provider.priority,
                            enabled: provider.enabled,
                            uri: provider.server ?? EMPTY_FORM.uri,
                          });
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="danger" icon="trash" onClick={() => setDeleting(provider)}>
                        Delete
                      </Button>
                    </>
                  ) : null}
                </>
              }
            >
              <div className="scp-stack">
                <DescriptionList
                  items={[
                    { term: 'Status', description: <ProviderHealthBadge state={provider.health.state} detail={provider.health.message} /> },
                    { term: 'Priority', description: <span className="scp-numeric">{provider.priority}</span> },
                    {
                      term: 'Enabled',
                      description: canManage ? (
                        <Switch
                          checked={provider.enabled}
                          label={`Enable ${provider.name}`}
                          onChange={(value) => void toggleEnabled(provider, value)}
                        />
                      ) : (
                        <StatusBadge tone={provider.enabled ? 'success' : 'neutral'}>
                          {provider.enabled ? 'Yes' : 'No'}
                        </StatusBadge>
                      ),
                    },
                    ...(provider.statistics?.users !== null && provider.statistics
                      ? [
                          { term: 'Users', description: <span className="scp-numeric">{provider.statistics.users}</span> },
                          { term: 'Groups', description: <span className="scp-numeric">{provider.statistics.groups}</span> },
                        ]
                      : []),
                    {
                      term: 'Capabilities',
                      description: (
                        <div className="scp-row scp-row-wrap">
                          {Object.entries(provider.capabilities)
                            .filter(([, enabled]) => enabled)
                            .map(([capability]) => (
                              <StatusBadge key={capability}>{capability}</StatusBadge>
                            ))}
                        </div>
                      ),
                    },
                  ]}
                />

                {result ? (
                  <InlineAlert
                    tone={result.ok ? 'success' : 'danger'}
                    title={result.summary}
                    evidence={result.checks.map(
                      (check) => `${check.ok ? '✓' : '×'} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`,
                    )}
                  />
                ) : null}
              </div>
            </Card>
          );
        })
      )}

      <Drawer
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={editingId ? 'Edit LDAP provider' : 'Add LDAP provider'}
        description="Credentials are stored encrypted and never returned by the API."
        size="wide"
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {editingId ? 'Save changes' : 'Add provider'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <Input
              label="Key"
              value={form.key}
              disabled={Boolean(editingId)}
              hint="Stable identifier used in the generated configuration, e.g. ldap-company."
              onChange={(event) => setForm({ ...form, key: event.target.value })}
            />
            <Input
              label="Display name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Input
              label="Priority"
              type="number"
              value={form.priority}
              hint="Lower numbers are consulted first."
              onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })}
            />
            <Input
              label="Server URI"
              value={form.uri}
              hint="ldaps://host or ldap://host. Use ldaps or StartTLS in production."
              onChange={(event) => setForm({ ...form, uri: event.target.value })}
            />
            <Input
              label="Search base"
              value={form.baseDn}
              onChange={(event) => setForm({ ...form, baseDn: event.target.value })}
            />
            <Input
              label="User filter"
              value={form.userFilter}
              hint="%s is replaced with the username, escaped per RFC 4515."
              onChange={(event) => setForm({ ...form, userFilter: event.target.value })}
            />
            <Input
              label="Bind DN"
              optional
              value={form.bindDn}
              hint="Leave empty for an anonymous bind."
              onChange={(event) => setForm({ ...form, bindDn: event.target.value })}
            />
            <PasswordInput
              label="Bind password"
              optional
              value={form.bindPassword}
              hint={editingId ? 'Leave empty to keep the stored password.' : undefined}
              onChange={(event) => setForm({ ...form, bindPassword: event.target.value })}
            />
            <Checkbox
              checked={form.startTls}
              label="Use StartTLS"
              description="Upgrade a plain ldap:// connection to TLS."
              onChange={(event) => setForm({ ...form, startTls: event.target.checked })}
            />
            <Checkbox
              checked={form.tlsRejectUnauthorized}
              label="Verify the server certificate"
              description="Disable only for a lab directory with a self-signed certificate."
              onChange={(event) => setForm({ ...form, tlsRejectUnauthorized: event.target.checked })}
            />
            <Input
              label="Group search base"
              optional
              value={form.groupBaseDn}
              hint="Required for group based access rules."
              onChange={(event) => setForm({ ...form, groupBaseDn: event.target.value })}
            />
            <Input
              label="Group filter"
              optional
              value={form.groupFilter}
              hint="%u is the user DN, %g the group name."
              onChange={(event) => setForm({ ...form, groupFilter: event.target.value })}
            />
            <Checkbox
              checked={form.enabled}
              label="Enable this provider"
              description="Disabled providers stay configured but are never consulted."
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
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
          'Users of this directory can no longer authenticate against the proxy once the configuration is deployed. Access rules that reference its groups stop matching.\n\nThis action cannot be undone.'
        }
        confirmWord="delete"
        confirmLabel="Delete provider"
        loading={busy}
      />
    </Page>
  );
}
