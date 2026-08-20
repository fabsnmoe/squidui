import { useState } from 'react';
import type { AccessProfile } from '@scp/shared';
import {
  Button,
  Card,
  DataTable,
  DescriptionList,
  ErrorState,
  Icon,
  IconButton,
  InlineAlert,
  MetricCard,
  Page,
  PageHeader,
  PasswordInput,
  Skeleton,
  StatusBadge,
  Tabs,
  useToast,
  type Column,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';
import { usePortal } from '../../lib/portal.js';
import { useQuery } from '../../lib/useQuery.js';
import { useTheme } from '../../lib/theme.js';
import { ActionBadge, formatDateTime } from '../../lib/display.js';

/**
 * Self-service portal for proxy users.
 *
 * Deliberately a small, separate shell: no sidebar, no control plane
 * navigation, three pages. A proxy user must never see something that looks
 * like an administration surface.
 */

interface Profile {
  username: string;
  displayName: string | null;
  description: string | null;
  status: string;
  provider: { key: string; name: string; type: string };
  groups: string[];
  canChangePassword: boolean;
  passwordUpdatedAt: string | null;
  memberSince: string | null;
}

interface AccessProfileResponse extends AccessProfile {
  identity: { username: string; groups: string[] };
}

interface Activity {
  events: Array<{ occurredAt: string; action: string; outcome: string; sourceIp: string | null }>;
  last30Days: { signIns: number; failedSignIns: number; lastSignInAt: string | null };
  traffic: {
    available: boolean;
    last30Days: { requests: number; bytes: number; denied: number };
  };
}

const TABS = [
  { id: 'account', label: 'My account' },
  { id: 'access', label: 'My access' },
  { id: 'activity', label: 'My activity' },
];

export function PortalApp(): JSX.Element {
  const { user, logout } = usePortal();
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState('account');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)' }}>
      <header className="scp-topbar" style={{ position: 'sticky', top: 0 }}>
        <span className="scp-sidebar-brand-mark" aria-hidden="true">
          <Icon name="shield" size={16} />
        </span>
        <span style={{ fontWeight: 'var(--font-weight-semibold)' }}>Proxy account</span>
        <span className="scp-spacer" />
        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          icon={theme === 'dark' ? 'sun' : 'moon'}
          onClick={toggle}
        />
        <StatusBadge tone="neutral">{user?.username ?? ''}</StatusBadge>
        <IconButton label="Sign out" icon="logout" onClick={() => void logout()} />
      </header>

      <main style={{ padding: 'var(--space-6)' }}>
        <Page>
          <PageHeader
            title={`Hello, ${user?.username ?? ''}`}
            description="Your proxy account: what you may reach, and how to change your password."
          />
          <Tabs tabs={TABS} active={tab} onChange={setTab} ariaLabel="Portal sections" />
          {tab === 'account' ? <AccountSection /> : null}
          {tab === 'access' ? <AccessSection /> : null}
          {tab === 'activity' ? <ActivitySection /> : null}
        </Page>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface ProxyAccountState {
  managed: boolean;
  hasAccount: boolean;
  username: string;
  passwordUpdatedAt?: string | null;
  notice?: string;
}

/**
 * The bridge between the two identity planes (ADR 0004).
 *
 * Signing in with an organisational identity proves who someone is. It does not
 * give Squid anything to check, because the proxy speaks HTTP Basic and cannot
 * consume a token. So the person sets a proxy password here, and that is what
 * the proxy will ask for.
 */
function ProxyAccountSection(): JSX.Element | null {
  const toast = useToast();
  const account = useQuery<ProxyAccountState>((signal) => api('/portal/proxy-account', { signal }));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = account.data;
  // Local proxy users already are their own account; nothing to provision.
  if (!data || !data.managed) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (data.hasAccount) {
        await api('/portal/proxy-account/password', { method: 'POST', body: { password } });
        toast.success('Proxy password changed', 'Use it the next time the proxy asks for credentials.');
      } else {
        await api('/portal/proxy-account', {
          method: 'POST',
          body: { username: username || data.username, password },
        });
        toast.success('Proxy account created', 'You can now authenticate against the proxy.');
      }
      setPassword('');
      setConfirmation('');
      account.reload();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Unexpected error.';
      const violations =
        cause instanceof ApiError && Array.isArray(cause.details)
          ? (cause.details as Array<{ message?: string }>).map((entry) => entry.message).filter(Boolean)
          : [];
      setError(violations.length > 0 ? `${message} ${violations.join(' ')}` : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={data.hasAccount ? 'Proxy password' : 'Create your proxy account'}
      description={
        data.hasAccount
          ? 'The credentials the proxy asks for when you browse.'
          : 'You are signed in, but the proxy cannot check a sign-in token. Choose the credentials it will ask for.'
      }
    >
      <InlineAlert tone="info" title="This is not your organisational password">
        {data.notice ??
          'This password is used only by the proxy. It is separate from your organisational password and is never checked against it.'}
      </InlineAlert>
      {error ? (
        <InlineAlert tone="danger" title="Could not save">
          {error}
        </InlineAlert>
      ) : null}
      {data.hasAccount ? (
        <p className="scp-secondary">
          Your proxy username is <span className="scp-mono">{data.username}</span>.
        </p>
      ) : (
        <Input
          label="Proxy username"
          value={username || data.username}
          hint="Suggested from your account. It has to be unique across the proxy."
          onChange={(event) => setUsername(event.target.value)}
        />
      )}
      <PasswordInput
        label={data.hasAccount ? 'New proxy password' : 'Proxy password'}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <PasswordInput
        label="Repeat password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <Button variant="primary" loading={busy} disabled={password.length === 0} onClick={() => void submit()}>
        {data.hasAccount ? 'Change proxy password' : 'Create proxy account'}
      </Button>
    </Card>
  );
}

function AccountSection(): JSX.Element {
  const toast = useToast();
  const profile = useQuery<Profile>((signal) => api('/portal/me', { signal }));
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changePassword = async (): Promise<void> => {
    setError(null);
    if (next !== confirmation) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/portal/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success('Password changed', 'Use the new password the next time the proxy asks for credentials.');
      setCurrent('');
      setNext('');
      setConfirmation('');
      profile.reload();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Unexpected error.';
      const violations =
        cause instanceof ApiError && Array.isArray(cause.details)
          ? (cause.details as Array<{ message?: string }>).map((entry) => entry.message).filter(Boolean)
          : [];
      setError(violations.length > 0 ? `${message} ${violations.join(' ')}` : message);
    } finally {
      setBusy(false);
    }
  };

  if (profile.error) {
    return <ErrorState message={profile.error.message} onRetry={profile.reload} />;
  }
  if (profile.loading || !profile.data) {
    return (
      <Card>
        <Skeleton width="40%" height={20} />
        <div style={{ height: 'var(--space-4)' }} />
        <Skeleton height={80} />
      </Card>
    );
  }

  const data = profile.data;

  return (
    <>
      {/* Renders nothing for a local proxy user, who already has an account. */}
      <ProxyAccountSection />
      <Card title="Account" description="How the proxy knows you.">
        <DescriptionList
          items={[
            { term: 'Username', description: <span className="scp-mono">{data.username}</span> },
            { term: 'Display name', description: data.displayName ?? '—' },
            {
              term: 'Authenticated by',
              description: (
                <span className="scp-row">
                  {data.provider.name}
                  <StatusBadge tone={data.provider.type === 'LOCAL' ? 'accent' : 'info'}>
                    {data.provider.type === 'LOCAL' ? 'Local account' : 'Directory account'}
                  </StatusBadge>
                </span>
              ),
            },
            {
              term: 'Groups',
              description:
                data.groups.length === 0 ? (
                  <span className="scp-muted">No groups</span>
                ) : (
                  <div className="scp-row scp-row-wrap">
                    {data.groups.map((group) => (
                      <StatusBadge key={group}>{group}</StatusBadge>
                    ))}
                  </div>
                ),
            },
            { term: 'Password last changed', description: formatDateTime(data.passwordUpdatedAt) },
            ...(data.memberSince ? [{ term: 'Account created', description: formatDateTime(data.memberSince) }] : []),
          ]}
        />
      </Card>

      <Card
        title="Change password"
        description="This is the password the proxy asks for. It is stored as a hash and can never be read back."
      >
        {data.canChangePassword ? (
          <div className="scp-stack">
            {error ? <InlineAlert tone="danger" title="Could not change password">{error}</InlineAlert> : null}
            <PasswordInput
              label="Current password"
              value={current}
              autoComplete="current-password"
              onChange={(event) => setCurrent(event.target.value)}
            />
            <PasswordInput
              label="New password"
              value={next}
              hint="At least 12 characters."
              onChange={(event) => setNext(event.target.value)}
            />
            <PasswordInput
              label="Repeat new password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <div>
              <Button variant="primary" loading={busy} onClick={() => void changePassword()}>
                Change password
              </Button>
            </div>
          </div>
        ) : (
          <InlineAlert tone="info" title="Managed by your organisation's directory">
            {`Your account comes from ${data.provider.name}. Change your password where your organisation manages it; the proxy picks up the change automatically.`}
          </InlineAlert>
        )}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function AccessSection(): JSX.Element {
  const access = useQuery<AccessProfileResponse>((signal) => api('/portal/access-profile', { signal }));

  if (access.error) return <ErrorState message={access.error.message} onRetry={access.reload} />;
  if (access.loading || !access.data) {
    return (
      <Card>
        <Skeleton width="40%" height={20} />
        <div style={{ height: 'var(--space-4)' }} />
        <Skeleton height={120} />
      </Card>
    );
  }

  const data = access.data;

  const columns: Array<Column<AccessProfileResponse['entries'][number]>> = [
    { id: 'action', header: '', width: '90px', cell: (row) => <ActionBadge action={row.action} /> },
    {
      id: 'summary',
      header: 'What applies to you',
      cell: (row) => (
        <div>
          <div>{row.summary}</div>
          <div className="scp-hint">
            {row.name}
            {row.description ? ` — ${row.description}` : ''}
          </div>
        </div>
      ),
    },
    { id: 'source', header: 'From', cell: (row) => <span className="scp-mono">{row.source}</span> },
    { id: 'schedule', header: 'When', cell: (row) => row.schedule },
  ];

  return (
    <>
      <div className="scp-grid">
        <MetricCard
          label="Proxy authentication"
          value={<StatusBadge tone={data.mode === 'DISABLED' ? 'warning' : 'success'}>{data.mode}</StatusBadge>}
          hint={
            data.mode === 'DISABLED'
              ? 'The proxy currently does not ask for credentials.'
              : 'The proxy identifies you before applying rules.'
          }
        />
        <MetricCard label="Rules that apply to you" value={data.entries.length} hint={`${data.notApplicable} do not`} />
        <MetricCard
          label="Anything not listed"
          value={<StatusBadge tone={data.defaultAccess === 'ALLOW' ? 'warning' : 'neutral'}>{data.defaultAccess}</StatusBadge>}
          hint="Default access policy"
        />
      </div>

      <Card
        title="Your access profile"
        description="Derived from the same policy engine the proxy uses, evaluated for your identity and groups."
        flush
      >
        <DataTable
          columns={columns}
          rows={data.entries}
          rowKey={(row) => row.ruleId}
          caption="Rules that apply to your account"
          empty={{
            icon: 'shield',
            title: 'No rule mentions your account',
            description:
              data.defaultAccess === 'ALLOW'
                ? 'Nothing is restricted specifically for you, and the default policy allows access.'
                : 'No rule grants you access, so the default policy blocks your requests. Contact your administrator.',
          }}
        />
      </Card>

      <Card title="How to read this">
        <ul className="scp-stack" style={{ gap: 'var(--space-2)' }}>
          {data.notes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function ActivitySection(): JSX.Element {
  const activity = useQuery<Activity>((signal) => api('/portal/activity', { signal }));

  if (activity.error) return <ErrorState message={activity.error.message} onRetry={activity.reload} />;
  if (activity.loading || !activity.data) {
    return (
      <Card>
        <Skeleton width="40%" height={20} />
        <div style={{ height: 'var(--space-4)' }} />
        <Skeleton height={120} />
      </Card>
    );
  }

  const data = activity.data;

  const columns: Array<Column<Activity['events'][number]>> = [
    {
      id: 'when',
      header: 'When',
      sortValue: (row) => row.occurredAt,
      cell: (row) => <span className="scp-numeric">{formatDateTime(row.occurredAt)}</span>,
    },
    {
      id: 'what',
      header: 'What',
      cell: (row) => (
        <span>
          {row.action === 'PROXY_PORTAL_LOGIN_SUCCEEDED'
            ? 'Signed in to this portal'
            : row.action === 'PROXY_PORTAL_LOGIN_FAILED'
              ? 'Failed sign-in attempt'
              : row.action === 'PROXY_PORTAL_LOGOUT'
                ? 'Signed out'
                : 'Password changed'}
        </span>
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: (row) => (
        <StatusBadge tone={row.outcome === 'SUCCESS' ? 'success' : 'danger'}>{row.outcome}</StatusBadge>
      ),
    },
    { id: 'ip', header: 'From', cell: (row) => <span className="scp-mono">{row.sourceIp ?? '—'}</span> },
  ];

  return (
    <>
      <div className="scp-grid">
        <MetricCard label="Sign-ins (30 days)" value={data.last30Days.signIns} />
        <MetricCard
          label="Failed sign-ins (30 days)"
          value={data.last30Days.failedSignIns}
          hint={data.last30Days.failedSignIns > 0 ? 'Not you? Tell your administrator.' : undefined}
        />
        <MetricCard label="Last sign-in" value={formatDateTime(data.last30Days.lastSignInAt)} />
        <MetricCard
          label="Requests through the proxy"
          value={data.traffic.last30Days.requests}
          available={data.traffic.available}
          unavailableText="Not measured yet"
          hint={
            data.traffic.available
              ? `${data.traffic.last30Days.denied} blocked, last 30 days`
              : 'No proxy node has reported traffic yet.'
          }
        />
      </div>

      <Card title="Recent account activity" description="Everything recorded for your account in this portal." flush>
        <DataTable
          columns={columns}
          rows={data.events}
          rowKey={(row) => `${row.occurredAt}-${row.action}`}
          caption="Recent activity for your account"
          empty={{ icon: 'audit', title: 'No activity recorded yet', description: 'Your sign-ins will appear here.' }}
        />
      </Card>
    </>
  );
}
