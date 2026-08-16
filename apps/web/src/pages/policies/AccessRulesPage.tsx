import { useState } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Drawer,
  FormSection,
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
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';
import { ActionBadge, identityLabel } from '../../lib/display.js';

/**
 * Access rules.
 *
 * Simple rules are edited in one drawer with the section order from
 * PLAN.md section 24 (Basic, Source, Identity, Destination, Schedule, Action).
 * The stepped wizard for complex rules is not implemented yet - see
 * docs/status.md.
 */

type IdentityKind = 'ANY' | 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'USER' | 'GROUP';

interface Rule {
  id: string;
  position: number;
  name: string;
  description: string | null;
  enabled: boolean;
  action: 'ALLOW' | 'DENY';
  source: { kind: string; networkIds?: string[] };
  identity: { kind: IdentityKind; userIds?: string[]; groupIds?: string[] };
  destination: { kind: string; domains?: string[]; ports?: number[]; cidrs?: string[] };
  schedule: { kind: string };
  scope: 'GLOBAL' | 'NODE_GROUP';
  scope_group_ids: string[];
}

interface RuleForm {
  id: string | null;
  name: string;
  description: string;
  action: 'ALLOW' | 'DENY';
  enabled: boolean;
  sourceKind: 'ANY' | 'NETWORKS';
  networkIds: string[];
  identityKind: IdentityKind;
  groupIds: string[];
  userIds: string[];
  destinationKind: 'ANY' | 'SPECIFIC';
  domains: string;
  ports: string;
  scope: 'GLOBAL' | 'NODE_GROUP';
  scopeGroupIds: string[];
}

const EMPTY_FORM: RuleForm = {
  id: null,
  name: '',
  description: '',
  action: 'ALLOW',
  enabled: true,
  sourceKind: 'ANY',
  networkIds: [],
  identityKind: 'ANY',
  groupIds: [],
  userIds: [],
  destinationKind: 'ANY',
  domains: '',
  ports: '',
  scope: 'GLOBAL',
  scopeGroupIds: [],
};

export function AccessRulesPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const rules = useQuery<{ items: Rule[] }>((signal) => api('/access-rules', { signal }));
  const networks = useQuery<{ items: Array<{ id: string; name: string }> }>((signal) => api('/networks', { signal }));
  const groups = useQuery<{ items: Array<{ id: string; name: string; source: string }> }>((signal) =>
    api('/proxy-groups', { signal }),
  );
  const users = useQuery<{ items: Array<{ id: string; username: string }> }>((signal) => api('/proxy-users', { signal }));
  const nodeGroups = useQuery<{ items: Array<{ id: string; name: string }> }>((signal) =>
    api('/node-groups', { signal }),
  );

  const [form, setForm] = useState<RuleForm | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = can('POLICY_MANAGE');
  const networkName = (id: string): string => networks.data?.items.find((entry) => entry.id === id)?.name ?? id;

  const columns: Array<Column<Rule>> = [
    {
      id: 'position',
      header: '#',
      width: '64px',
      sortValue: (row) => row.position,
      cell: (row) => <span className="scp-numeric scp-muted">{row.position}</span>,
    },
    {
      id: 'name',
      header: 'Rule',
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
      cell: (row) =>
        row.source.kind === 'NETWORKS' ? (
          <div className="scp-row scp-row-wrap">
            {(row.source.networkIds ?? []).map((id) => (
              <StatusBadge key={id}>{networkName(id)}</StatusBadge>
            ))}
          </div>
        ) : (
          <span className="scp-muted">Any</span>
        ),
    },
    { id: 'identity', header: 'Identity', cell: (row) => <StatusBadge tone="info">{identityLabel(row.identity)}</StatusBadge> },
    {
      id: 'scope',
      header: 'Applies to',
      cell: (row) =>
        row.scope === 'NODE_GROUP' ? (
          <StatusBadge tone="warning">{`${(row.scope_group_ids ?? []).length} group(s)`}</StatusBadge>
        ) : (
          <span className="scp-hint">All nodes</span>
        ),
    },
    {
      id: 'destination',
      header: 'Destination',
      cell: (row) =>
        row.destination.kind === 'SPECIFIC' ? (
          <span className="scp-mono">
            {[...(row.destination.domains ?? []), ...(row.destination.ports ?? []).map((port) => `:${port}`)].join(' ') ||
              'Any'}
          </span>
        ) : (
          <span className="scp-muted">Any</span>
        ),
    },
    { id: 'action', header: 'Action', cell: (row) => <ActionBadge action={row.action} /> },
    {
      id: 'enabled',
      header: 'Enabled',
      cell: (row) =>
        canManage ? (
          <Switch
            checked={row.enabled}
            label={`Enable rule ${row.name}`}
            onChange={(value) => void toggle(row, value)}
          />
        ) : (
          <StatusBadge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Yes' : 'No'}</StatusBadge>
        ),
    },
  ];

  const toggle = async (rule: Rule, enabled: boolean): Promise<void> => {
    try {
      await api(`/access-rules/${rule.id}`, { method: 'PATCH', body: { enabled } });
      rules.reload();
    } catch (error) {
      toast.error('Could not update rule', error instanceof ApiError ? error.message : 'Unexpected error.');
    }
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    if (form.scope === 'NODE_GROUP' && form.scopeGroupIds.length === 0) {
      setFormError('Select at least one node group, or set the scope back to global.');
      return;
    }

    setBusy(true);
    setFormError(null);

    const identity =
      form.identityKind === 'GROUP'
        ? { kind: 'GROUP', groupIds: form.groupIds }
        : form.identityKind === 'USER'
          ? { kind: 'USER', userIds: form.userIds }
          : { kind: form.identityKind };

    const destination =
      form.destinationKind === 'SPECIFIC'
        ? {
            kind: 'SPECIFIC',
            domains: form.domains.split(/[\s,]+/).filter(Boolean),
            ports: form.ports.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite),
            cidrs: [],
          }
        : { kind: 'ANY' };

    const body = {
      name: form.name,
      description: form.description || null,
      enabled: form.enabled,
      action: form.action,
      source: form.sourceKind === 'NETWORKS' ? { kind: 'NETWORKS', networkIds: form.networkIds } : { kind: 'ANY' },
      identity,
      destination,
      schedule: { kind: 'ALWAYS' },
      scope: form.scope,
      // An empty list on a group-scoped rule would silently apply nowhere, so
      // the editor refuses to save it below rather than storing it.
      scopeGroupIds: form.scope === 'NODE_GROUP' ? form.scopeGroupIds : [],
    };

    try {
      if (form.id) {
        await api(`/access-rules/${form.id}`, { method: 'PATCH', body });
        toast.success('Rule updated', form.name);
      } else {
        await api('/access-rules', { method: 'POST', body });
        toast.success('Rule created', form.name);
      }
      setForm(null);
      rules.reload();
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
      await api(`/access-rules/${deleting.id}`, { method: 'DELETE' });
      toast.success('Rule deleted', deleting.name);
      setDeleting(null);
      rules.reload();
    } catch (error) {
      toast.error('Could not delete rule', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Access rules"
        description="Evaluated top to bottom; the first matching rule decides. What no rule matches falls through to the default access policy."
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => { setFormError(null); setForm({ ...EMPTY_FORM }); }}>
              Create rule
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        <DataTable
          columns={columns}
          rows={rules.data?.items ?? []}
          rowKey={(row) => row.id}
          caption="Access rules"
          loading={rules.loading}
          error={rules.error}
          onRetry={rules.reload}
          empty={{
            icon: 'rules',
            title: 'No access rules yet',
            description:
              'Without rules every request falls through to the default access policy. Start with an explicit final deny rule and add the traffic you want to permit above it.',
            ...(canManage
              ? {
                  action: (
                    <Button variant="primary" icon="plus" onClick={() => setForm({ ...EMPTY_FORM })}>
                      Create the first rule
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
                          action: row.action,
                          enabled: row.enabled,
                          sourceKind: row.source.kind === 'NETWORKS' ? 'NETWORKS' : 'ANY',
                          networkIds: row.source.networkIds ?? [],
                          scope: row.scope ?? 'GLOBAL',
                          scopeGroupIds: row.scope_group_ids ?? [],
                          identityKind: row.identity.kind,
                          groupIds: row.identity.groupIds ?? [],
                          userIds: row.identity.userIds ?? [],
                          destinationKind: row.destination.kind === 'SPECIFIC' ? 'SPECIFIC' : 'ANY',
                          domains: (row.destination.domains ?? []).join(' '),
                          ports: (row.destination.ports ?? []).join(' '),
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
        title={form?.id ? `Edit ${form.name}` : 'Create access rule'}
        size="wide"
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {form?.id ? 'Save changes' : 'Create rule'}
            </Button>
          </>
        }
      >
        {formError ? <InlineAlert tone="danger" title="Could not save">{formError}</InlineAlert> : null}
        {form ? (
          <>
            <FormSection title="Basic" description="What this rule is called and whether it is active.">
              <Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <Input
                label="Description"
                optional
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </FormSection>

            <FormSection
              title="Where it applies"
              description="A rule is global unless a site genuinely needs its own. Global keeps the list readable, which is worth more than the flexibility."
            >
              <Select
                label="Scope"
                value={form.scope}
                options={[
                  { value: 'GLOBAL', label: 'Global — every proxy node' },
                  { value: 'NODE_GROUP', label: 'Selected node groups only' },
                ]}
                onChange={(event) =>
                  setForm({ ...form, scope: event.target.value as 'GLOBAL' | 'NODE_GROUP' })
                }
              />
              {form.scope === 'NODE_GROUP' ? (
                <>
                  {(nodeGroups.data?.items ?? []).map((group) => (
                    <label key={group.id} className="scp-checkbox">
                      <input
                        type="checkbox"
                        checked={form.scopeGroupIds.includes(group.id)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            scopeGroupIds: event.target.checked
                              ? [...form.scopeGroupIds, group.id]
                              : form.scopeGroupIds.filter((id) => id !== group.id),
                          })
                        }
                      />
                      <span>{group.name}</span>
                    </label>
                  ))}
                  {form.scopeGroupIds.length === 0 ? (
                    <InlineAlert tone="warning" title="No group selected">
                      A rule scoped to node groups without a group applies nowhere at all. Pick at least one group,
                      or set the scope back to global.
                    </InlineAlert>
                  ) : null}
                </>
              ) : null}
            </FormSection>

            <FormSection title="Source" description="Which client addresses this rule applies to.">
              <Select
                label="Source"
                value={form.sourceKind}
                options={[
                  { value: 'ANY', label: 'Any source address' },
                  { value: 'NETWORKS', label: 'Specific networks' },
                ]}
                onChange={(event) => setForm({ ...form, sourceKind: event.target.value as 'ANY' | 'NETWORKS' })}
              />
              {form.sourceKind === 'NETWORKS'
                ? (networks.data?.items ?? []).map((network) => (
                    <label key={network.id} className="scp-checkbox">
                      <input
                        type="checkbox"
                        checked={form.networkIds.includes(network.id)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            networkIds: event.target.checked
                              ? [...form.networkIds, network.id]
                              : form.networkIds.filter((id) => id !== network.id),
                          })
                        }
                      />
                      <span>{network.name}</span>
                    </label>
                  ))
                : null}
            </FormSection>

            <FormSection
              title="Identity"
              description="Which proxy identity must be present. Unauthenticated matches clients that presented no credentials."
            >
              <Select
                label="Identity"
                value={form.identityKind}
                options={[
                  { value: 'ANY', label: 'Any — authenticated or not' },
                  { value: 'AUTHENTICATED', label: 'Authenticated — any known user' },
                  { value: 'UNAUTHENTICATED', label: 'Unauthenticated — no credentials' },
                  { value: 'USER', label: 'Specific users' },
                  { value: 'GROUP', label: 'User group' },
                ]}
                onChange={(event) => setForm({ ...form, identityKind: event.target.value as IdentityKind })}
              />
              {form.identityKind === 'GROUP'
                ? (groups.data?.items ?? []).map((group) => (
                    <label key={group.id} className="scp-checkbox">
                      <input
                        type="checkbox"
                        checked={form.groupIds.includes(group.id)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            groupIds: event.target.checked
                              ? [...form.groupIds, group.id]
                              : form.groupIds.filter((id) => id !== group.id),
                          })
                        }
                      />
                      <span>
                        {group.name} <span className="scp-hint">({group.source.toLowerCase()})</span>
                      </span>
                    </label>
                  ))
                : null}
              {form.identityKind === 'USER'
                ? (users.data?.items ?? []).map((user) => (
                    <label key={user.id} className="scp-checkbox">
                      <input
                        type="checkbox"
                        checked={form.userIds.includes(user.id)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            userIds: event.target.checked
                              ? [...form.userIds, user.id]
                              : form.userIds.filter((id) => id !== user.id),
                          })
                        }
                      />
                      <span className="scp-mono">{user.username}</span>
                    </label>
                  ))
                : null}
            </FormSection>

            <FormSection title="Destination" description="Where the client is allowed to go.">
              <Select
                label="Destination"
                value={form.destinationKind}
                options={[
                  { value: 'ANY', label: 'Any destination' },
                  { value: 'SPECIFIC', label: 'Specific domains or ports' },
                ]}
                onChange={(event) => setForm({ ...form, destinationKind: event.target.value as 'ANY' | 'SPECIFIC' })}
              />
              {form.destinationKind === 'SPECIFIC' ? (
                <>
                  <Input
                    label="Domains"
                    optional
                    value={form.domains}
                    hint="Space separated. A leading dot also matches subdomains, e.g. .example.com"
                    onChange={(event) => setForm({ ...form, domains: event.target.value })}
                  />
                  <Input
                    label="Ports"
                    optional
                    value={form.ports}
                    hint="Space separated, e.g. 80 443"
                    onChange={(event) => setForm({ ...form, ports: event.target.value })}
                  />
                </>
              ) : null}
            </FormSection>

            <FormSection title="Action" description="What happens when everything above matches.">
              <Select
                label="Action"
                value={form.action}
                options={[
                  { value: 'ALLOW', label: 'Allow' },
                  { value: 'DENY', label: 'Deny' },
                ]}
                onChange={(event) => setForm({ ...form, action: event.target.value as 'ALLOW' | 'DENY' })}
              />
              <Switch
                checked={form.enabled}
                label="Rule is enabled"
                onChange={(value) => setForm({ ...form, enabled: value })}
              />
            </FormSection>
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete rule ${deleting?.position ?? ''} "${deleting?.name ?? ''}"?`}
        consequence={
          deleting?.action === 'ALLOW'
            ? 'Traffic that only this rule permitted will fall through to the rules below it, and possibly to the default access policy.\n\nThis action cannot be undone.'
            : 'Traffic that this rule blocked may be permitted by a later rule or by the default access policy.\n\nThis action cannot be undone.'
        }
        confirmWord="delete"
        confirmLabel="Delete rule"
        loading={busy}
      />
    </Page>
  );
}
