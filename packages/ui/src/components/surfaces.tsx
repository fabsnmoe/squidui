import { useState, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { IconButton } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Removes body padding, for tables that fill the card. */
  flush?: boolean;
  children?: ReactNode;
}

export function Card({ title, description, actions, footer, flush, children }: CardProps): JSX.Element {
  return (
    <section className="scp-card">
      {title || actions ? (
        <header className="scp-card-header">
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            {title ? <h2 className="scp-card-title">{title}</h2> : null}
            {description ? <p className="scp-card-description">{description}</p> : null}
          </div>
          {actions ? <div className="scp-row">{actions}</div> : null}
        </header>
      ) : null}
      {children ? (
        <div className="scp-card-body" data-flush={flush ? 'true' : 'false'}>
          {children}
        </div>
      ) : null}
      {footer ? <footer className="scp-card-footer">{footer}</footer> : null}
    </section>
  );
}

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /**
   * When the data source for this metric does not exist yet, pass
   * `available={false}`. The card then says so instead of showing a zero that
   * looks like a measurement (design principle 9).
   */
  available?: boolean;
  unavailableText?: string;
  accessory?: ReactNode;
}

export function MetricCard({
  label,
  value,
  hint,
  available = true,
  unavailableText = 'No data source connected',
  accessory,
}: MetricCardProps): JSX.Element {
  return (
    <section className="scp-card">
      <div className="scp-card-body">
        <div className="scp-row">
          <span className="scp-metric-label">{label}</span>
          <span className="scp-spacer" />
          {accessory}
        </div>
        <div className="scp-metric-value" data-empty={!available}>
          {available ? value : unavailableText}
        </div>
        {hint ? <div className="scp-metric-hint">{hint}</div> : null}
      </div>
    </section>
  );
}

export interface DescriptionListProps {
  items: Array<{ term: ReactNode; description: ReactNode }>;
}

export function DescriptionList({ items }: DescriptionListProps): JSX.Element {
  return (
    <dl className="scp-description-list">
      {items.map((item, index) => (
        <div key={index} style={{ display: 'contents' }}>
          <dt>{item.term}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatusCardProps {
  title: string;
  status: ReactNode;
  items: Array<{ term: ReactNode; description: ReactNode }>;
  actions?: ReactNode;
}

export function StatusCard({ title, status, items, actions }: StatusCardProps): JSX.Element {
  return (
    <Card title={title} actions={actions}>
      <div className="scp-stack">
        <div>{status}</div>
        <DescriptionList items={items} />
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Page header                                                                 */
/* -------------------------------------------------------------------------- */

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  actions?: ReactNode;
}

export function PageHeader({ title, description, breadcrumbs, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className="scp-page-header">
      <div className="scp-page-header-text">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav className="scp-breadcrumbs" aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={index} className="scp-row">
                {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}
                {index < breadcrumbs.length - 1 ? <Icon name="chevronRight" size={14} /> : null}
              </span>
            ))}
          </nav>
        ) : null}
        {/* Route changes move focus here, so it must be focusable. */}
        <h1 className="scp-page-title" tabIndex={-1}>
          {title}
        </h1>
        {description ? <p className="scp-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="scp-row scp-row-wrap">{actions}</div> : null}
    </header>
  );
}

export function Page({
  children,
  width = 'default',
}: {
  children: ReactNode;
  width?: 'default' | 'wide';
}): JSX.Element {
  return (
    <div className="scp-page" data-width={width}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

export interface TabsProps {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export function Tabs({ tabs, active, onChange, ariaLabel }: TabsProps): JSX.Element {
  return (
    <div className="scp-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="scp-tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Code viewer                                                                 */
/* -------------------------------------------------------------------------- */

export interface CodeViewerProps {
  code: string;
  title?: string;
  /** Shows a redaction notice instead of the content. */
  redacted?: boolean;
  redactedReason?: string;
}

export function CodeViewer({ code, title, redacted, redactedReason }: CodeViewerProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (redacted) {
    return (
      <div className="scp-code" style={{ color: 'var(--color-text-muted)' }}>
        {redactedReason ?? 'This artefact contains secrets and is not displayed.'}
      </div>
    );
  }

  return (
    <div className="scp-stack" style={{ gap: 'var(--space-2)' }}>
      <div className="scp-row">
        {title ? <span className="scp-secondary">{title}</span> : null}
        <span className="scp-spacer" />
        <IconButton
          label={copied ? 'Copied' : 'Copy to clipboard'}
          icon={copied ? 'check' : 'copy'}
          onClick={() => void copy()}
        />
      </div>
      <pre className="scp-code" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
