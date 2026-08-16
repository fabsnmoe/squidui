import type { AuthenticationMode, ProviderHealthState, SecurityFinding } from '@scp/shared';
import { HealthIndicator, InlineAlert, StatusBadge, type HealthState, type Tone } from '@scp/ui';

/**
 * The status mapping from docs/design/colors.md, in one place so every page
 * shows the same concept in the same colour.
 */

export const MODE_TONE: Record<AuthenticationMode, Tone> = {
  REQUIRED: 'success',
  OPTIONAL: 'info',
  DISABLED: 'warning',
};

export const HEALTH_STATE: Record<ProviderHealthState, HealthState> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  UNREACHABLE: 'danger',
  DISABLED: 'neutral',
  UNKNOWN: 'neutral',
};

export const HEALTH_LABEL: Record<ProviderHealthState, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNREACHABLE: 'Unreachable',
  DISABLED: 'Disabled',
  UNKNOWN: 'Unknown',
};

export function ModeBadge({ mode }: { mode: AuthenticationMode }): JSX.Element {
  return <StatusBadge tone={MODE_TONE[mode]}>{mode.charAt(0) + mode.slice(1).toLowerCase()}</StatusBadge>;
}

export function ProviderHealthBadge({
  state,
  detail,
}: {
  state: ProviderHealthState;
  detail?: string;
}): JSX.Element {
  return <HealthIndicator state={HEALTH_STATE[state]} label={HEALTH_LABEL[state]} {...(detail ? { detail } : {})} />;
}

export function ActionBadge({ action }: { action: 'ALLOW' | 'DENY' }): JSX.Element {
  return <StatusBadge tone={action === 'ALLOW' ? 'success' : 'danger'}>{action}</StatusBadge>;
}

const FINDING_TONE = { CRITICAL: 'danger', WARNING: 'warning', INFO: 'info' } as const;

/** Renders compiler and policy findings consistently everywhere they appear. */
export function FindingAlert({
  finding,
  actions,
}: {
  finding: SecurityFinding;
  actions?: JSX.Element;
}): JSX.Element {
  return (
    <InlineAlert
      tone={FINDING_TONE[finding.severity]}
      title={finding.title}
      evidence={finding.evidence}
      {...(actions ? { actions } : {})}
    >
      {finding.detail}
    </InlineAlert>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function identityLabel(identity: { kind: string } | null | undefined): string {
  switch (identity?.kind) {
    case 'AUTHENTICATED':
      return 'Authenticated';
    case 'UNAUTHENTICATED':
      return 'Unauthenticated';
    case 'USER':
      return 'Specific users';
    case 'GROUP':
      return 'User group';
    default:
      return 'Any';
  }
}
