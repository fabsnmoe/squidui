import { Link } from 'react-router-dom';
import type { AuthenticationMode, SecurityFinding } from '@scp/shared';
import { describeAuthenticationMode } from '@scp/shared';
import {
  Button,
  Card,
  DescriptionList,
  ErrorState,
  MetricCard,
  Page,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '@scp/ui';
import { api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { FindingAlert, ModeBadge, ProviderHealthBadge } from '../lib/display.js';

/**
 * Dashboard (PLAN.md section 23).
 *
 * Answers, in order: is anything wrong, what is the authentication posture,
 * are the nodes reachable, how big is the policy set. Metrics without a data
 * source say so rather than showing a zero.
 */

interface DashboardResponse {
  authentication: {
    mode: AuthenticationMode;
    realm: string;
    defaultAccess: 'ALLOW' | 'DENY';
    providers: Array<{
      key: string;
      name: string;
      enabled: boolean;
      health: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' | 'DISABLED' | 'UNKNOWN';
      priority: number;
    }>;
  };
  findings: SecurityFinding[];
  issues: string[];
  nodes: { total: number; byStatus: Record<string, number>; available: boolean };
  policies: { rules: number; enabledRules: number; listeners: number };
  identities: { proxyUsers: number; proxyGroups: number };
  configuration: { versions: number };
  traffic: {
    available: boolean;
    authenticatedRequests: number | null;
    unauthenticatedRequests: number | null;
    authenticationFailures24h: number;
  };
}

export function DashboardPage(): JSX.Element {
  const query = useQuery<DashboardResponse>((signal) => api('/dashboard', { signal }));

  if (query.error) {
    return (
      <Page>
        <PageHeader title="Dashboard" description="Operational overview of the control plane." />
        <ErrorState
          message={query.error.message}
          {...(query.error.detail ? { detail: query.error.detail } : {})}
          onRetry={query.reload}
        />
      </Page>
    );
  }

  const data = query.data;

  return (
    <Page width="wide">
      <PageHeader
        title="Dashboard"
        description="Whether the proxy works, who may use it, and what needs attention."
        actions={
          <Button icon="refresh" onClick={query.reload}>
            Refresh
          </Button>
        }
      />

      {query.loading ? (
        <div className="scp-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index}>
              <Skeleton width="50%" />
              <div style={{ height: 'var(--space-3)' }} />
              <Skeleton width="30%" height={24} />
            </Card>
          ))}
        </div>
      ) : data ? (
        <>
          {data.findings.map((finding) => (
            <FindingAlert
              key={finding.code}
              finding={finding}
              actions={
                <Link to="/authentication">
                  <Button variant="secondary">Open authentication settings</Button>
                </Link>
              }
            />
          ))}

          <div className="scp-grid">
            <MetricCard
              label="Authentication mode"
              value={<ModeBadge mode={data.authentication.mode} />}
              hint={describeAuthenticationMode(data.authentication.mode)}
            />
            <MetricCard
              label="Default access"
              value={
                <StatusBadge tone={data.authentication.defaultAccess === 'ALLOW' ? 'warning' : 'success'}>
                  {data.authentication.defaultAccess}
                </StatusBadge>
              }
              hint="Applies when no access rule matches."
            />
            <MetricCard
              label="Active access rules"
              value={data.policies.enabledRules}
              hint={`${data.policies.rules} rules in total, ${data.policies.listeners} listeners`}
            />
            <MetricCard
              label="Proxy identities"
              value={data.identities.proxyUsers}
              hint={`${data.identities.proxyGroups} groups`}
            />
          </div>

          <div className="scp-grid">
            <Card title="Providers" description="Who can authenticate clients right now.">
              {data.authentication.providers.length === 0 ? (
                <p className="scp-secondary">No provider configured.</p>
              ) : (
                <DescriptionList
                  items={data.authentication.providers.map((provider) => ({
                    term: (
                      <span>
                        {provider.name}{' '}
                        {provider.enabled ? null : <span className="scp-hint">(disabled)</span>}
                      </span>
                    ),
                    description: <ProviderHealthBadge state={provider.health} />,
                  }))}
                />
              )}
            </Card>

            <Card title="Proxy nodes" description="Reachability of the managed Squid instances.">
              {data.nodes.available ? (
                <DescriptionList
                  items={Object.entries(data.nodes.byStatus).map(([status, count]) => ({
                    term: status,
                    description: <span className="scp-numeric">{count}</span>,
                  }))}
                />
              ) : (
                <p className="scp-secondary">
                  No node has reported yet. Node reporting arrives with the agent, which is not part of this
                  release.
                </p>
              )}
            </Card>
          </div>

          <div className="scp-grid">
            <MetricCard
              label="Authenticated requests"
              value={data.traffic.authenticatedRequests ?? 0}
              available={data.traffic.available}
              unavailableText="Traffic log pipeline not connected"
              hint="Requests that carried a proxy identity."
            />
            <MetricCard
              label="Unauthenticated requests"
              value={data.traffic.unauthenticatedRequests ?? 0}
              available={data.traffic.available}
              unavailableText="Traffic log pipeline not connected"
              hint="Requests without a proxy identity."
            />
            <MetricCard
              label="Failed authentications (24 h)"
              value={data.traffic.authenticationFailures24h}
              hint="Control plane logins and authentication tests recorded in the audit log."
            />
            <MetricCard
              label="Compiled configurations"
              value={data.configuration.versions}
              hint="Stored versions available for review."
            />
          </div>

          {data.issues.length > 0 ? (
            <Card title="Configuration issues" description="Dangling references found while building the rule set.">
              <ul className="scp-stack" style={{ gap: 'var(--space-1)' }}>
                {data.issues.map((issue) => (
                  <li key={issue}>• {issue}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
