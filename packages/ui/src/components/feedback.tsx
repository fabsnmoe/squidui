import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon.js';
import { Button, IconButton } from './primitives.js';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

/* -------------------------------------------------------------------------- */
/* Badges and health                                                           */
/* -------------------------------------------------------------------------- */

export interface StatusBadgeProps {
  tone?: Tone;
  children: ReactNode;
  icon?: IconName;
}

/** Colour is never the only channel: the badge always carries a label. */
export function StatusBadge({ tone = 'neutral', children, icon }: StatusBadgeProps): JSX.Element {
  return (
    <span className="scp-badge" data-tone={tone}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export type HealthState = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface HealthIndicatorProps {
  state: HealthState;
  label: string;
  detail?: ReactNode;
}

/** Dot shape differs per state so the meaning survives greyscale. */
export function HealthIndicator({ state, label, detail }: HealthIndicatorProps): JSX.Element {
  return (
    <span className="scp-health" data-state={state}>
      <span className="scp-health-dot" aria-hidden="true" />
      <span>{label}</span>
      {detail ? <span className="scp-muted">{detail}</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Inline alert                                                                */
/* -------------------------------------------------------------------------- */

export interface InlineAlertProps {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title: ReactNode;
  children?: ReactNode;
  /** Monospace evidence lines, e.g. which listeners triggered a finding. */
  evidence?: string[];
  actions?: ReactNode;
  onDismiss?: () => void;
}

export function InlineAlert({
  tone = 'info',
  title,
  children,
  evidence,
  actions,
  onDismiss,
}: InlineAlertProps): JSX.Element {
  const icon: IconName = tone === 'info' ? 'info' : tone === 'success' ? 'check' : 'alert';
  return (
    <div className="scp-alert" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="scp-alert-icon">
        <Icon name={icon} size={20} />
      </span>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div className="scp-alert-title">{title}</div>
        {children ? <div className="scp-alert-body">{children}</div> : null}
        {evidence && evidence.length > 0 ? (
          <div className="scp-alert-evidence">
            {evidence.map((line, index) => (
              <span key={index}>• {line}</span>
            ))}
          </div>
        ) : null}
        {actions ? (
          <div className="scp-row" style={{ marginTop: 'var(--space-3)' }}>
            {actions}
          </div>
        ) : null}
      </div>
      {onDismiss ? <IconButton label="Dismiss" icon="close" onClick={onDismiss} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading, empty and error states                                             */
/* -------------------------------------------------------------------------- */

export function Skeleton({ width = '100%', height = 14 }: { width?: string | number; height?: number }): JSX.Element {
  return <div className="scp-skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }): JSX.Element {
  return (
    <div className="scp-stack" style={{ padding: 'var(--space-5)' }} aria-busy="true" aria-live="polite">
      <span className="scp-visually-hidden">Loading</span>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="scp-row" style={{ gap: 'var(--space-4)' }}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} width={columnIndex === 0 ? '28%' : '18%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon = 'info', title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="scp-empty">
      <span className="scp-empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="scp-empty-title">{title}</div>
      {description ? <p className="scp-empty-description">{description}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  detail?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  detail,
  onRetry,
}: ErrorStateProps): JSX.Element {
  return (
    <div className="scp-error-state" role="alert">
      <span className="scp-empty-icon" style={{ color: 'var(--color-danger-fg)' }}>
        <Icon name="alert" size={22} />
      </span>
      <div className="scp-empty-title">{title}</div>
      <p className="scp-empty-description">{message}</p>
      {detail ? (
        <details style={{ maxWidth: '52ch' }}>
          <summary className="scp-hint" style={{ cursor: 'pointer' }}>
            Technical detail
          </summary>
          <pre className="scp-code" style={{ textAlign: 'left', marginTop: 'var(--space-2)' }}>
            {detail}
          </pre>
        </details>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                       */
/* -------------------------------------------------------------------------- */

export interface ToastMessage {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (message: Omit<ToastMessage, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const toast = useCallback(
    (message: Omit<ToastMessage, 'id'>) => {
      const id = nextId.current++;
      setMessages((current) => [...current, { ...message, id }]);
      // Errors stay longer: they usually need reading, not just noticing.
      window.setTimeout(() => dismiss(id), message.tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: 'success', title, ...(description ? { description } : {}) }),
      error: (title, description) => toast({ tone: 'error', title, ...(description ? { description } : {}) }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="scp-toast-region" role="region" aria-label="Notifications">
        {messages.map((message) => (
          <div
            key={message.id}
            className="scp-toast"
            data-tone={message.tone}
            role={message.tone === 'error' ? 'alert' : 'status'}
            aria-live={message.tone === 'error' ? 'assertive' : 'polite'}
          >
            <span style={{ marginTop: 2 }}>
              <Icon name={message.tone === 'success' ? 'check' : message.tone === 'error' ? 'alert' : 'info'} />
            </span>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontWeight: 'var(--font-weight-medium)' }}>{message.title}</div>
              {message.description ? <div className="scp-hint">{message.description}</div> : null}
            </div>
            <IconButton label="Dismiss notification" icon="close" onClick={() => dismiss(message.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider.');
  return context;
}
