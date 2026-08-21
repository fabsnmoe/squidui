import { useState } from 'react';
import {
  Button,
  Card,
  DescriptionList,
  InlineAlert,
  Input,
  Page,
  PageHeader,
  PasswordInput,
  StatusBadge,
  Switch,
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useQuery } from '../lib/useQuery.js';
import { useTheme } from '../lib/theme.js';

export function SettingsPage(): JSX.Element {
  const { user, build, refresh } = useSession();
  const { theme, set } = useTheme();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settings = useQuery<{
    traffic: { logUrls: boolean; retentionDays: number; retentionConfigurableAt: string };
    accessLease: { leaseDays: number; renewalWindowDays: number };
  }>((signal) => api('/settings', { signal }));
  const [lease, setLease] = useState<{ leaseDays: string; renewalWindowDays: string } | null>(null);
  const [leaseBusy, setLeaseBusy] = useState(false);

  const setTrafficLogUrls = async (enabled: boolean): Promise<void> => {
    try {
      await api('/settings', { method: 'PATCH', body: { trafficLogUrls: enabled } });
      toast.success(
        enabled ? 'Full URL logging enabled' : 'Full URL logging disabled',
        enabled ? 'New requests will record the complete URL.' : 'Only the destination host and port are recorded.',
      );
      settings.reload();
    } catch (cause) {
      toast.error('Could not change the setting', cause instanceof ApiError ? cause.message : 'Unexpected error.');
    }
  };

  const changePassword = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('/session/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      await refresh();
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
    <Page>
      <PageHeader title="Settings" description="Your control plane account and this installation." />

      {user?.mustChangePassword ? (
        <InlineAlert tone="warning" title="Change your bootstrap password">
          This account still uses the password from the initial installation. Replace it before handing the system over.
        </InlineAlert>
      ) : null}

      <Card title="Your account" description="This is a control plane account. It cannot authenticate against the proxy.">
        <DescriptionList
          items={[
            { term: 'Username', description: <span className="scp-mono">{user?.username ?? ''}</span> },
            { term: 'Display name', description: user?.displayName ?? '—' },
            {
              term: 'Permissions',
              description: (
                <div className="scp-row scp-row-wrap">
                  {(user?.permissions ?? []).map((permission) => (
                    <StatusBadge key={permission}>{permission}</StatusBadge>
                  ))}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Change password">
        <div className="scp-stack">
          {error ? <InlineAlert tone="danger" title="Could not change password">{error}</InlineAlert> : null}
          <PasswordInput
            label="Current password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <PasswordInput
            label="New password"
            value={next}
            hint="At least 12 characters."
            onChange={(event) => setNext(event.target.value)}
          />
          <div>
            <Button variant="primary" loading={busy} onClick={() => void changePassword()}>
              Change password
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Appearance">
        <div className="scp-row">
          <Button variant={theme === 'light' ? 'primary' : 'secondary'} icon="sun" onClick={() => set('light')}>
            Light
          </Button>
          <Button variant={theme === 'dark' ? 'primary' : 'secondary'} icon="moon" onClick={() => set('dark')}>
            Dark
          </Button>
        </div>
      </Card>

      <Card
        title="Traffic logging"
        description="What is recorded about each request the proxies handle."
      >
        <div className="scp-stack">
          <DescriptionList
            items={[
              {
                term: 'Always recorded',
                description: (
                  <span className="scp-secondary">
                    Time, node, client address, username when present, destination host and port, method, HTTP
                    status, bytes, duration, cache result and policy result.
                  </span>
                ),
              },
              {
                term: 'Retention',
                description: (
                  <span>
                    {settings.data?.traffic.retentionDays ?? 30} days for individual requests
                    <span className="scp-hint">
                      {' '}
                      — set with {settings.data?.traffic.retentionConfigurableAt ?? 'TRAFFIC_LOG_RETENTION_DAYS'}.
                      Hourly counters are kept beyond that.
                    </span>
                  </span>
                ),
              },
            ]}
          />

          <Switch
            checked={settings.data?.traffic.logUrls ?? false}
            label="Record the full request URL"
            description="Off by default. The destination host and port are always recorded; this adds the path and query string."
            onChange={(value) => void setTrafficLogUrls(value)}
          />

          {settings.data?.traffic.logUrls ? (
            <InlineAlert tone="warning" title="Full URLs are being recorded">
              This stores considerably more detailed usage data about individual people — every path and query
              string, which can include search terms, document identifiers and tokens. Make sure this is covered by
              your organisation's policy and, where applicable, agreed with the works council.
            </InlineAlert>
          ) : (
            <InlineAlert tone="info" title="Only the destination is recorded">
              Logs show that someone reached example.com:443, not which page they opened. Enabling full URLs stores
              considerably more detailed usage data about individual people.
            </InlineAlert>
          )}
        </div>
      </Card>

      <Card
        title="Directory access"
        description="How long proxy access lasts for people who signed in with an identity provider."
      >
        <div className="scp-stack">
          <InlineAlert tone="info" title="Why access expires at all">
            An identity provider cannot be asked whether a user still exists, so access is granted as a lease that
            only a sign-in renews — and a sign-in re-checks the claim. Someone removed from the directory can no
            longer sign in, so their proxy access ends when the lease runs out.
          </InlineAlert>
          <Input
            label="Lease length in days"
            type="number"
            value={lease?.leaseDays ?? String(settings.data?.accessLease.leaseDays ?? 90)}
            hint="How long access lasts after each sign-in. Shorter means a smaller window in which a removed user keeps access."
            onChange={(event) =>
              setLease({
                leaseDays: event.target.value,
                renewalWindowDays:
                  lease?.renewalWindowDays ?? String(settings.data?.accessLease.renewalWindowDays ?? 5),
              })
            }
          />
          <Input
            label="Renewal possible from, in days before expiry"
            type="number"
            value={lease?.renewalWindowDays ?? String(settings.data?.accessLease.renewalWindowDays ?? 5)}
            hint="Signing in earlier than this records the check but does not extend the lease."
            onChange={(event) =>
              setLease({
                leaseDays: lease?.leaseDays ?? String(settings.data?.accessLease.leaseDays ?? 90),
                renewalWindowDays: event.target.value,
              })
            }
          />
          <Button
            variant="primary"
            disabled={!lease}
            loading={leaseBusy}
            onClick={() => {
              if (!lease) return;
              setLeaseBusy(true);
              void api('/settings', {
                method: 'PATCH',
                body: {
                  leaseDays: Number(lease.leaseDays),
                  renewalWindowDays: Number(lease.renewalWindowDays),
                },
              })
                .then(() => {
                  toast.success('Access policy saved', 'It applies at the next sign-in.');
                  setLease(null);
                  settings.reload();
                })
                .catch((error: unknown) =>
                  toast.error(
                    'Could not save',
                    error instanceof ApiError ? error.message : 'Unexpected error.',
                  ),
                )
                .finally(() => setLeaseBusy(false));
            }}
          >
            Save access policy
          </Button>
          <p className="scp-hint">
            Shortening the lease does not shorten leases already granted; those keep their date until the next
            renewal.
          </p>
        </div>
      </Card>

      <Card title="Installation" description="What is deployed right now.">
        <DescriptionList
          items={[
            { term: 'Version', description: <span className="scp-mono">{build?.appVersion ?? 'unknown'}</span> },
            { term: 'Git revision', description: <span className="scp-mono">{build?.gitSha ?? 'unknown'}</span> },
            { term: 'Build date', description: <span className="scp-mono">{build?.buildDate ?? 'unknown'}</span> },
          ]}
        />
      </Card>
    </Page>
  );
}
