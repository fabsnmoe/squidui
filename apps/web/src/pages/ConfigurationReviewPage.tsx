import { useState } from 'react';
import type { SecurityFinding } from '@scp/shared';
import {
  Button,
  Card,
  CodeViewer,
  DescriptionList,
  ErrorState,
  InlineAlert,
  Page,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  useToast,
} from '@scp/ui';
import { ApiError, api } from '../lib/api.js';
import { useQuery } from '../lib/useQuery.js';
import { useSession } from '../lib/session.js';
import { FindingAlert } from '../lib/display.js';

interface PreviewResponse {
  squidConf: string;
  adapterId: string;
  warnings: Array<{ code: string; message: string; ruleId?: string }>;
  findings: SecurityFinding[];
  issues: string[];
  artefacts: Array<{
    path: string;
    mode: string;
    sensitive: boolean;
    description: string;
    lineCount: number;
    content: string | null;
  }>;
  ir: { authentication: { mode: string }; defaultAccess: string; rules: unknown[] };
}

export function ConfigurationReviewPage(): JSX.Element {
  const { can } = useSession();
  const toast = useToast();
  const preview = useQuery<PreviewResponse>((signal) => api('/configuration/preview', { signal }));
  const [tab, setTab] = useState('squid');
  const [compiling, setCompiling] = useState(false);

  const compile = async (): Promise<void> => {
    setCompiling(true);
    try {
      await api('/configuration/compile', { method: 'POST' });
      toast.success('Configuration compiled', 'A new version was stored for review.');
      preview.reload();
    } catch (error) {
      toast.error('Compilation failed', error instanceof ApiError ? error.message : 'Unexpected error.');
    } finally {
      setCompiling(false);
    }
  };

  if (preview.error) {
    return (
      <Page>
        <PageHeader title="Configuration review" description="The Squid configuration generated from your policies." />
        <ErrorState
          message={preview.error.message}
          {...(preview.error.detail ? { detail: preview.error.detail } : {})}
          onRetry={preview.reload}
        />
      </Page>
    );
  }

  const data = preview.data;
  const artefactTabs = (data?.artefacts ?? []).map((artefact) => ({ id: artefact.path, label: artefact.path.split('/').pop() ?? artefact.path }));

  return (
    <Page width="wide">
      <PageHeader
        title="Configuration review"
        description="Exactly what the control plane would write to the proxy nodes. Compilation is deterministic, so two identical policy sets always produce identical output."
        actions={
          can('CONFIG_COMPILE') ? (
            <Button variant="primary" icon="file" loading={compiling} onClick={() => void compile()}>
              Compile and store version
            </Button>
          ) : undefined
        }
      />

      {preview.loading ? (
        <Card>
          <Skeleton width="40%" height={20} />
          <div style={{ height: 'var(--space-4)' }} />
          <Skeleton height={220} />
        </Card>
      ) : data ? (
        <>
          {data.findings.map((finding) => (
            <FindingAlert key={finding.code} finding={finding} />
          ))}

          {data.warnings.length > 0 ? (
            <InlineAlert
              tone="warning"
              title={`${data.warnings.length} compiler warning${data.warnings.length === 1 ? '' : 's'}`}
              evidence={data.warnings.map((warning) => `${warning.code}: ${warning.message}`)}
            >
              The configuration is valid, but these points change how it behaves in practice.
            </InlineAlert>
          ) : null}

          {data.issues.length > 0 ? (
            <InlineAlert tone="danger" title="Unresolved references" evidence={data.issues}>
              Some rules refer to entities that no longer exist. They were skipped while building the configuration.
            </InlineAlert>
          ) : null}

          <Card title="Summary">
            <DescriptionList
              items={[
                { term: 'Squid adapter', description: <span className="scp-mono">{data.adapterId}</span> },
                { term: 'Authentication mode', description: <StatusBadge>{data.ir.authentication.mode}</StatusBadge> },
                { term: 'Default access', description: <StatusBadge>{data.ir.defaultAccess}</StatusBadge> },
                { term: 'Rules', description: <span className="scp-numeric">{data.ir.rules.length}</span> },
                { term: 'Generated artefacts', description: <span className="scp-numeric">{data.artefacts.length}</span> },
              ]}
            />
          </Card>

          <Card
            title="Generated files"
            description="squid.conf plus every file the authentication providers need on the node."
          >
            <div className="scp-stack">
              <Tabs
                ariaLabel="Generated files"
                active={tab}
                onChange={setTab}
                tabs={[{ id: 'squid', label: 'squid.conf' }, ...artefactTabs]}
              />

              {tab === 'squid' ? (
                <CodeViewer code={data.squidConf} title="/etc/squid/squid.conf" />
              ) : (
                (() => {
                  const artefact = data.artefacts.find((entry) => entry.path === tab);
                  if (!artefact) return null;
                  return (
                    <div className="scp-stack">
                      <p className="scp-secondary">{artefact.description}</p>
                      <DescriptionList
                        items={[
                          { term: 'Path', description: <span className="scp-mono">{artefact.path}</span> },
                          { term: 'Mode', description: <span className="scp-mono">{artefact.mode}</span> },
                          { term: 'Lines', description: <span className="scp-numeric">{artefact.lineCount}</span> },
                        ]}
                      />
                      <CodeViewer
                        code={artefact.content ?? ''}
                        title={artefact.path}
                        redacted={artefact.sensitive}
                        redactedReason="This file contains password hashes. It is generated and deployed, but never displayed in the UI or returned by the API."
                      />
                    </div>
                  );
                })()
              )}
            </div>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
