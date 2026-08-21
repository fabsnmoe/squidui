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
  PasswordInput,
  StatusBadge,
  Switch,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';

/**
 * OIDC identity providers (ADR 0004).
 *
 * Two doors, one configuration: the control plane and the self-service portal.
 * Admission is one claim comparison per door - deliberately not a permission
 * mapping layer, because a half-expressive one is harder to reason about than
 * none at all.
 */

interface Provider {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  allowAdminLogin: boolean;
  allowPortalLogin: boolean;
  adminClaim: string | null;
  adminValue: string | null;
  portalClaim: string | null;
  portalValue: string | null;
  usernameClaim: string;
}

interface Form extends Provider {
  clientSecret: string;
}

const emptyForm = (): Form => ({
  id: '',
  key: 'keycloak',
  name: 'Keycloak',
  enabled: true,
  issuer: '',
  clientId: '',
  hasClientSecret: false,
  clientSecret: '',
  scopes: 'openid profile email',
  allowAdminLogin: false,
  allowPortalLogin: true,
  adminClaim: 'realm_access.roles',
  adminValue: '',
  portalClaim: '',
  portalValue: '',
  usernameClaim: 'preferred_username',
});

export function IdentityProvidersPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const providers = useQuery<{ items: Provider[]; redirectUri: string }>((signal) =>
    api('/identity-providers', { signal }),
  );
  const [form, setForm] = useState<Form | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const canManage = can('CP_USER_MANAGE');

  const columns: Array<Column<Provider>> = [
    { id: 'name', header: 'Provider', sortValue: (row) => row.name, cell: (row) => row.name },
    { id: 'issuer', header: 'Issuer', cell: (row) => <span className="scp-mono">{row.issuer}</span> },
    {
      id: 'doors',
      header: 'Signs in',
      cell: (row) => (
        <span className="scp-row">
          {row.allowAdminLogin ? <StatusBadge tone="warning">Administrators</StatusBadge> : null}
          {row.allowPortalLogin ? <StatusBadge tone="info">Portal users</StatusBadge> : null}
          {!row.allowAdminLogin && !row.allowPortalLogin ? (
            <span className="scp-hint">Nobody — both doors closed</span>
          ) : null}
        </span>
      ),
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
      key: form.key,
      name: form.name,
      enabled: form.enabled,
      issuer: form.issuer,
      clientId: form.clientId,
      // Omitted on edit unless something was typed, so an unchanged secret is
      // never sent back and forth.
      ...(creating || form.clientSecret ? { clientSecret: form.clientSecret || null } : {}),
      scopes: form.scopes,
      allowAdminLogin: form.allowAdminLogin,
      allowPortalLogin: form.allowPortalLogin,
      adminClaim: form.adminClaim,
      adminValue: form.adminValue,
      portalClaim: form.portalClaim,
      portalValue: form.portalValue,
      usernameClaim: form.usernameClaim,
    };
    try {
      if (creating) await api('/identity-providers', { method: 'POST', body });
      else await api(`/identity-providers/${form.id}`, { method: 'PATCH', body });
      toast.success(creating ? 'Provider created' : 'Provider updated', form.name);
      setForm(null);
      providers.reload();
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (row: Provider): Promise<void> => {
    setProbe(null);
    try {
      const result = await api<{ ok: boolean; message?: string; authorizationEndpoint?: string }>(
        `/identity-providers/${row.id}/test`,
        { method: 'POST' },
      );
      if (result.ok) toast.success('Provider reachable', result.authorizationEndpoint ?? '');
      else toast.error('Provider not reachable', result.message ?? '');
    } catch (error) {
      toast.error('Test failed', error instanceof ApiError ? error.message : 'Unexpected error.');
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/identity-providers/${deleting.id}`, { method: 'DELETE' });
      toast.success('Provider deleted', deleting.name);
      setDeleting(null);
      providers.reload();
    } catch (error) {
      toast.error('Could not delete', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Identity providers"
        description="Sign in to this control plane and to the self-service portal with an OpenID Connect provider such as Keycloak. Proxy traffic is unaffected: Squid speaks HTTP Basic and cannot use a token, so portal users provision a proxy account with its own password."
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFormError(null);
                setCreating(true);
                setForm(emptyForm());
              }}
            >
              Add provider
            </Button>
          ) : undefined
        }
      />

      {providers.data ? (
        <InlineAlert tone="info" title="Redirect URI to register with the provider">
          <span className="scp-mono">{providers.data.redirectUri}</span>
          <div className="scp-hint">
            The provider must allow exactly this value. Set PUBLIC_BASE_URL in the environment when the control
            plane runs behind a reverse proxy, otherwise it is derived from the request and may not match.
          </div>
        </InlineAlert>
      ) : null}

      <Card flush>
        <DataTable
          columns={columns}
          rows={providers.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Identity providers"
          loading={providers.loading}
          error={providers.error}
          onRetry={providers.reload}
          empty={{
            icon: 'key',
            title: 'No identity providers',
            description: 'Sign-in uses local accounts only until a provider is configured.',
          }}
          rowActions={
            canManage
              ? (row) => (
                  <>
                    <IconButton label={`Test ${row.name}`} icon="test" onClick={() => void test(row)} />
                    <IconButton
                      label={`Edit ${row.name}`}
                      icon="edit"
                      onClick={() => {
                        setCreating(false);
                        setFormError(null);
                        setForm({ ...row, clientSecret: '' });
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
        size="wide"
        title={creating ? 'Add identity provider' : `Edit ${form?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {creating ? 'Add provider' : 'Save changes'}
            </Button>
          </>
        }
      >
        {formError ? (
          <InlineAlert tone="danger" title="Could not save">
            {formError}
          </InlineAlert>
        ) : null}
        {probe ? <InlineAlert tone="info" title="Provider">{probe}</InlineAlert> : null}
        {form ? (
          <>
            <Input
              label="Name"
              value={form.name}
              hint="Shown on the sign-in screen as “Continue with …”."
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Input
              label="Key"
              value={form.key}
              disabled={!creating}
              hint="Lowercase identifier, fixed once created."
              onChange={(event) => setForm({ ...form, key: event.target.value })}
            />
            <Input
              label="Issuer URL"
              value={form.issuer}
              hint="For Keycloak: https://keycloak.example.de/realms/<realm>"
              onChange={(event) => setForm({ ...form, issuer: event.target.value })}
            />
            <Input
              label="Client ID"
              value={form.clientId}
              onChange={(event) => setForm({ ...form, clientId: event.target.value })}
            />
            <PasswordInput
              label="Client secret"
              value={form.clientSecret}
              hint={
                form.hasClientSecret && !creating
                  ? 'A secret is stored. Leave empty to keep it.'
                  : 'Leave empty for a public client that uses PKCE only.'
              }
              onChange={(event) => setForm({ ...form, clientSecret: event.target.value })}
            />
            <Input
              label="Scopes"
              value={form.scopes}
              onChange={(event) => setForm({ ...form, scopes: event.target.value })}
            />
            <Input
              label="Username claim"
              value={form.usernameClaim}
              hint="Which claim becomes the username here. Keycloak sends preferred_username."
              onChange={(event) => setForm({ ...form, usernameClaim: event.target.value })}
            />

            <Switch
              checked={form.allowAdminLogin}
              label="May sign in to the control plane"
              onChange={(value) => setForm({ ...form, allowAdminLogin: value })}
            />
            {form.allowAdminLogin ? (
              <>
                <InlineAlert tone="warning" title="Everyone admitted here is a full administrator">
                  There is no partial mapping. Anyone whose token carries the claim below receives the
                  Administrator role in full. Leave the claim empty only if every user of this provider should
                  administer the control plane.
                </InlineAlert>
                <Input
                  label="Administrator claim"
                  value={form.adminClaim ?? ''}
                  hint="Dotted path, for example realm_access.roles"
                  onChange={(event) => setForm({ ...form, adminClaim: event.target.value })}
                />
                <Input
                  label="Required value"
                  value={form.adminValue ?? ''}
                  hint="The claim must contain this value, for example squid-admin."
                  onChange={(event) => setForm({ ...form, adminValue: event.target.value })}
                />
              </>
            ) : null}

            <Switch
              checked={form.allowPortalLogin}
              label="May sign in to the self-service portal"
              onChange={(value) => setForm({ ...form, allowPortalLogin: value })}
            />
            {form.allowPortalLogin ? (
              <>
                <Input
                  label="Portal claim"
                  value={form.portalClaim ?? ''}
                  hint="Leave empty to admit every authenticated user."
                  onChange={(event) => setForm({ ...form, portalClaim: event.target.value })}
                />
                <Input
                  label="Required value"
                  value={form.portalValue ?? ''}
                  onChange={(event) => setForm({ ...form, portalValue: event.target.value })}
                />
              </>
            ) : null}

            <Switch
              checked={form.enabled}
              label="Provider is enabled"
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
        consequence={'Nobody will be able to sign in through this provider afterwards.\n\nProxy accounts already provisioned keep working: their passwords live here, not in the provider.'}
        confirmWord="delete"
        confirmLabel="Delete provider"
        loading={busy}
      />
    </Page>
  );
}
