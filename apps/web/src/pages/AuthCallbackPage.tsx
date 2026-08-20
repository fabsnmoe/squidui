import { useEffect, useRef, useState } from 'react';
import { Button, Icon, InlineAlert } from '@scp/ui';
import { ApiError, api, setToken } from '../lib/api.js';
import { setStoredSessionKind } from '../lib/portal.js';

/**
 * Where the identity provider sends the browser back (ADR 0004).
 *
 * The code is exchanged once, the resulting token is stored, and the page then
 * navigates with a full load rather than a client-side route change. That is
 * deliberate: both session providers read the stored token when they mount, so
 * a reload is the simplest way to have either of them pick up a session that
 * was established outside their own sign-in path.
 */

export function AuthCallbackPage(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  // React mounts effects twice in development. Exchanging an authorisation code
  // twice fails by design - it is single use - so the second run is suppressed
  // rather than shown to the user as a failure.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const providerError = params.get('error');
    if (providerError) {
      setError(params.get('error_description') ?? providerError);
      return;
    }

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setError('The identity provider did not return a sign-in result.');
      return;
    }

    api<{ audience: 'control-plane' | 'proxy-portal'; token: string }>('/auth/oidc/callback', {
      method: 'POST',
      body: { code, state },
    })
      .then((result) => {
        setToken(result.token);
        setStoredSessionKind(result.audience === 'control-plane' ? 'control-plane' : 'portal');
        window.location.replace(result.audience === 'control-plane' ? '/' : '/portal');
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'The sign-in could not be completed.');
      });
  }, []);

  return (
    <div className="scp-login">
      <main className="scp-login-panel">
        <div className="scp-card">
          <div className="scp-stack">
            {error ? (
              <>
                <InlineAlert tone="danger" title="Sign in failed">
                  {error}
                </InlineAlert>
                <Button variant="primary" onClick={() => window.location.replace('/')}>
                  Back to sign in
                </Button>
              </>
            ) : (
              <div className="scp-row">
                <Icon name="shield" />
                <span>Completing sign in…</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
