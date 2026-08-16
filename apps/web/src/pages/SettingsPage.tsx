import { useState } from 'react';
import {
  Button,
  Card,
  DescriptionList,
  InlineAlert,
  Page,
  PageHeader,
  PasswordInput,
  StatusBadge,
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useTheme } from '../lib/theme.js';

export function SettingsPage(): JSX.Element {
  const { user, build, refresh } = useSession();
  const { theme, set } = useTheme();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
