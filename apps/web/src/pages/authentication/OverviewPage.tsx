import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthenticationMode, AuthenticationProviderSummary, SecurityFinding } from '@scp/shared';
import { describeAuthenticationMode } from '@scp/shared';
import {
  Button,
  Card,
  Checkbox,
  DescriptionList,
  ErrorState,
  InlineAlert,
  Page,
  PageHeader,
  RadioCard,
  Skeleton,
  StatusBadge,
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { useQuery } from '../../lib/useQuery.js';
import { useSession } from '../../lib/session.js';
import { FindingAlert, ProviderHealthBadge, formatDateTime } from '../../lib/display.js';

interface OverviewResponse {
  configuration: {
    mode: AuthenticationMode;
    defaultAccess: 'ALLOW' | 'DENY';
    realm: string;
    openProxyAcknowledgedAt: string | null;
    openProxyAcknowledgedBy: string | null;
    updatedAt: string;
  };
  providers: AuthenticationProviderSummary[];
  findings: SecurityFinding[];
  listeners: Array<{ id: string; name: string; address: string; port: number; enabled: boolean }>;
}

const MODES: AuthenticationMode[] = ['DISABLED', 'OPTIONAL', 'REQUIRED'];

export function AuthenticationOverviewPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const query = useQuery<OverviewResponse>((signal) => api('/proxy-auth/overview', { signal }));

  const [pendingMode, setPendingMode] = useState<AuthenticationMode | null>(null);
  const [pendingAccess, setPendingAccess] = useState<'ALLOW' | 'DENY' | null>(null);
  const [confirmFindings, setConfirmFindings] = useState<SecurityFinding[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);

  const editable = can('PROXY_AUTH_CONFIGURE');
  const configuration = query.data?.configuration;
  const mode = pendingMode ?? configuration?.mode ?? 'DISABLED';
  const defaultAccess = pendingAccess ?? configuration?.defaultAccess ?? 'DENY';
  const dirty =
    Boolean(configuration) && (mode !== configuration?.mode || defaultAccess !== configuration?.defaultAccess);

  const save = async (acknowledgeOpenProxy: boolean): Promise<void> => {
    setSaving(true);
    try {
      await api('/proxy-auth/config', {
        method: 'PATCH',
        body: { mode, defaultAccess, ...(acknowledgeOpenProxy ? { acknowledgeOpenProxy: true } : {}) },
      });
      toast.success('Authentication settings saved', `Mode is now ${mode.toLowerCase()}.`);
      setPendingMode(null);
      setPendingAccess(null);
      setConfirmFindings(null);
      setAcknowledged(false);
      query.reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OPEN_PROXY_CONFIRMATION_REQUIRED') {
        // Not a failure: the product allows this configuration, it just refuses
        // to let it happen unnoticed (PRODUCT.md section 5).
        const details = error.details as { findings?: SecurityFinding[] } | null;
        setConfirmFindings(details?.findings ?? []);
      } else {
        toast.error('Could not save', error instanceof ApiError ? error.message : 'Unexpected error.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (query.error) {
    return (
      <Page>
        <PageHeader title="Authentication" description="Proxy identity and authentication settings." />
        <ErrorState message={query.error.message} {...(query.error.detail ? { detail: query.error.detail } : {})} onRetry={query.reload} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Authentication"
        description="How clients identify themselves against the proxy. Control plane accounts are managed separately under System."
        actions={
          dirty && editable ? (
            <>
              <Button
                onClick={() => {
                  setPendingMode(null);
                  setPendingAccess(null);
                }}
              >
                Discard
              </Button>
              <Button variant="primary" loading={saving} onClick={() => void save(false)}>
                Save changes
              </Button>
            </>
          ) : undefined
        }
      />

      {query.loading ? (
        <Card>
          <div className="scp-stack">
            <Skeleton width="40%" height={20} />
            <Skeleton height={60} />
            <Skeleton height={60} />
          </div>
        </Card>
      ) : (
        <>
          {query.data?.findings.map((finding) => <FindingAlert key={finding.code} finding={finding} />)}

          {configuration?.openProxyAcknowledgedAt ? (
            <InlineAlert tone="info" title="Open proxy configuration was acknowledged">
              {`Acknowledged by ${configuration.openProxyAcknowledgedBy ?? 'unknown'} on ${formatDateTime(
                configuration.openProxyAcknowledgedAt,
              )}. The decision is recorded in the audit log.`}
            </InlineAlert>
          ) : null}

          <Card
            title="Authentication mode"
            description="Applies to every listener. Rules decide what an identified or anonymous client may reach."
          >
            <div className="scp-stack">
              {MODES.map((candidate) => (
                <RadioCard
                  key={candidate}
                  name="authentication-mode"
                  value={candidate}
                  checked={mode === candidate}
                  disabled={!editable}
                  onChange={(value) => setPendingMode(value as AuthenticationMode)}
                  title={candidate.charAt(0) + candidate.slice(1).toLowerCase()}
                  description={describeAuthenticationMode(candidate)}
                />
              ))}
            </div>
          </Card>

          <Card
            title="Default access"
            description="The decision when no access rule matches. An explicit final deny rule is usually clearer than relying on this."
          >
            <div className="scp-stack">
              <RadioCard
                name="default-access"
                value="DENY"
                checked={defaultAccess === 'DENY'}
                disabled={!editable}
                onChange={() => setPendingAccess('DENY')}
                title="Deny"
                description="Traffic that matches no rule is blocked. Recommended."
              />
              <RadioCard
                name="default-access"
                value="ALLOW"
                checked={defaultAccess === 'ALLOW'}
                disabled={!editable}
                onChange={() => setPendingAccess('ALLOW')}
                title="Allow"
                description="Traffic that matches no rule is permitted. Combined with disabled authentication this creates an open proxy."
              />
            </div>
          </Card>

          <Card
            title="Providers"
            description="Providers are consulted in priority order. Several can be active at the same time."
            actions={
              <Button icon="key" onClick={() => navigate('/authentication/providers')}>
                Manage providers
              </Button>
            }
          >
            <div className="scp-stack">
              {(query.data?.providers ?? []).length === 0 ? (
                <p className="scp-secondary">No provider configured.</p>
              ) : (
                (query.data?.providers ?? []).map((provider) => (
                  <div key={provider.id} className="scp-row" style={{ gap: 'var(--space-4)' }}>
                    <span style={{ minWidth: 180, fontWeight: 'var(--font-weight-medium)' }}>{provider.name}</span>
                    <StatusBadge tone="neutral">Priority {provider.priority}</StatusBadge>
                    <ProviderHealthBadge state={provider.health.state} detail={provider.health.message} />
                    <span className="scp-spacer" />
                    <StatusBadge tone={provider.enabled ? 'success' : 'neutral'}>
                      {provider.enabled ? 'Enabled' : 'Disabled'}
                    </StatusBadge>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card title="Listeners" description="Where Squid accepts client connections.">
            <DescriptionList
              items={(query.data?.listeners ?? []).map((listener) => ({
                term: listener.name,
                description: (
                  <span className="scp-mono">
                    {listener.address}:{listener.port} {listener.enabled ? '' : '(disabled)'}
                  </span>
                ),
              }))}
            />
          </Card>
        </>
      )}

      {/* Explicit acknowledgement instead of a silent save. */}
      {confirmFindings ? (
        <div className="scp-scrim" onMouseDown={(event) => event.target === event.currentTarget && setConfirmFindings(null)}>
          <div className="scp-dialog" role="dialog" aria-modal="true" aria-label="Confirm open proxy configuration">
            <h2 className="scp-dialog-title">Confirm this configuration</h2>
            {confirmFindings.map((finding) => (
              <FindingAlert key={finding.code} finding={finding} />
            ))}
            <Checkbox
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              label="I understand that clients can use this proxy without credentials"
              description="Your acknowledgement is recorded in the audit log."
            />
            <div className="scp-dialog-actions">
              <Button
                onClick={() => {
                  setConfirmFindings(null);
                  setAcknowledged(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={!acknowledged} loading={saving} onClick={() => void save(true)}>
                Save anyway
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Page>
  );
}
