import { useState, type FormEvent } from 'react';
import { Button, Icon, InlineAlert, Input, PasswordInput } from '@scp/ui';
import { ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { usePortal } from '../lib/portal.js';
import { useTheme } from '../lib/theme.js';

/**
 * One portal, two identity planes.
 *
 * The choice is explicit rather than guessed from the username: a control
 * plane account and a proxy account may share a name and are still different
 * accounts (PRODUCT.md section 1).
 */

type Mode = 'control-plane' | 'proxy';

export function LoginPage(): JSX.Element {
  const { login: loginOperator } = useSession();
  const { login: loginProxyUser } = usePortal();
  const { theme, toggle } = useTheme();

  const [mode, setMode] = useState<Mode>('control-plane');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'control-plane') await loginOperator(username, password);
      else await loginProxyUser(username, password);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'The control plane could not be reached. Check that the API is running.',
      );
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setPassword('');
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-6)',
        background: 'var(--color-bg)',
      }}
    >
      <div style={{ position: 'fixed', top: 'var(--space-4)', right: 'var(--space-4)' }}>
        <button type="button" className="scp-icon-button" onClick={toggle} aria-label="Toggle theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>

      <main style={{ width: 'min(420px, 100%)' }}>
        <div className="scp-stack" style={{ alignItems: 'center', marginBottom: 'var(--space-6)' }}>
          <span className="scp-sidebar-brand-mark" style={{ width: 40, height: 40 }} aria-hidden="true">
            <Icon name="shield" size={22} />
          </span>
          <h1 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-semibold)' }}>
            Squid Control Plane
          </h1>
        </div>

        <form className="scp-card" onSubmit={(event) => void onSubmit(event)}>
          <div className="scp-card-body scp-stack">
            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend className="scp-label" style={{ marginBottom: 'var(--space-2)' }}>
                Sign in as
              </legend>
              <div role="tablist" aria-label="Account type" className="scp-tabs">
                <button
                  type="button"
                  role="tab"
                  className="scp-tab"
                  aria-selected={mode === 'control-plane'}
                  onClick={() => switchMode('control-plane')}
                >
                  Administrator
                </button>
                <button
                  type="button"
                  role="tab"
                  className="scp-tab"
                  aria-selected={mode === 'proxy'}
                  onClick={() => switchMode('proxy')}
                >
                  Proxy user
                </button>
              </div>
            </fieldset>

            <p className="scp-secondary">
              {mode === 'control-plane'
                ? 'Manage policies, identities and configuration with your control plane account.'
                : 'Sign in with the account you use for the proxy to see your access and change your password.'}
            </p>

            {error ? <InlineAlert tone="danger" title="Sign in failed">{error}</InlineAlert> : null}

            <Input
              label="Username"
              value={username}
              autoComplete="username"
              autoFocus
              required
              onChange={(event) => setUsername(event.target.value)}
            />
            <PasswordInput
              label="Password"
              value={password}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" variant="primary" size="lg" loading={submitting}>
              {mode === 'control-plane' ? 'Sign in' : 'Sign in to my account'}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
