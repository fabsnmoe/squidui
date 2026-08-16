import { useState, type FormEvent } from 'react';
import type { AuthenticationTestResult } from '@scp/shared';
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
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../../lib/api.js';

/**
 * Authentication -> Test (PRODUCT.md section 22).
 *
 * The password is sent once, never stored, never logged, and the field is
 * cleared as soon as the request completes.
 */

const OUTCOME_TONE = {
  SUCCESS: 'success',
  REJECTED: 'danger',
  UNAVAILABLE: 'warning',
  SKIPPED: 'neutral',
} as const;

export function AuthenticationTestPage(): JSX.Element {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sourceIp, setSourceIp] = useState('');
  const [result, setResult] = useState<AuthenticationTestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const response = await api<AuthenticationTestResult>('/auth-test', {
        method: 'POST',
        body: { username, password, ...(sourceIp ? { sourceIp } : {}) },
      });
      setResult(response);
    } catch (error) {
      toast.error('Test could not run', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      // Clearing here rather than on success only: a failed attempt must not
      // leave the password sitting in the DOM either.
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Authentication test"
        description="Verify credentials against the configured providers exactly as Squid would. Nothing you enter here is stored or logged."
      />

      <div className="scp-grid">
        <Card title="Credentials" description="The providers are tried in priority order.">
          <form className="scp-stack" onSubmit={(event) => void submit(event)}>
            <Input
              label="Username"
              value={username}
              autoComplete="off"
              required
              onChange={(event) => setUsername(event.target.value)}
            />
            <PasswordInput
              label="Password"
              value={password}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
            <Input
              label="Source IP"
              optional
              value={sourceIp}
              hint="Recorded with the attempt; it does not influence the provider decision."
              onChange={(event) => setSourceIp(event.target.value)}
            />
            <Button type="submit" variant="primary" loading={busy} icon="test">
              Run test
            </Button>
          </form>
        </Card>

        <Card title="Result" description="What each provider answered.">
          {!result ? (
            <p className="scp-secondary">Run a test to see which provider accepts the credentials.</p>
          ) : (
            <div className="scp-stack">
              <InlineAlert
                tone={result.success ? 'success' : 'danger'}
                title={result.success ? 'Authentication successful' : 'Authentication failed'}
              >
                {result.message}
              </InlineAlert>

              {result.success ? (
                <DescriptionList
                  items={[
                    { term: 'Provider', description: result.providerName ?? '—' },
                    { term: 'User', description: <span className="scp-mono">{result.username}</span> },
                    {
                      term: 'Groups',
                      description:
                        result.groups.length === 0 ? (
                          <span className="scp-muted">No groups reported</span>
                        ) : (
                          <div className="scp-row scp-row-wrap">
                            {result.groups.map((group) => (
                              <StatusBadge key={group}>{group}</StatusBadge>
                            ))}
                          </div>
                        ),
                    },
                  ]}
                />
              ) : null}

              <div>
                <div className="scp-hint" style={{ marginBottom: 'var(--space-2)' }}>
                  Provider attempts
                </div>
                <div className="scp-stack" style={{ gap: 'var(--space-2)' }}>
                  {result.attempts.map((attempt) => (
                    <div key={attempt.providerKey} className="scp-row" style={{ gap: 'var(--space-3)' }}>
                      <StatusBadge tone={OUTCOME_TONE[attempt.outcome]}>{attempt.outcome}</StatusBadge>
                      <span style={{ fontWeight: 'var(--font-weight-medium)' }}>{attempt.providerName}</span>
                      <span className="scp-hint">{attempt.message}</span>
                      <span className="scp-spacer" />
                      <span className="scp-hint scp-numeric">{attempt.durationMs} ms</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
