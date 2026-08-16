import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Input } from './primitives.js';

/**
 * Overlays share one behaviour contract (docs/design/accessibility.md):
 * focus moves in on open, is trapped while open, `Esc` closes, and focus
 * returns to the trigger on close.
 */

function useOverlayBehaviour(open: boolean, onClose: () => void, containerRef: React.RefObject<HTMLElement>): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    const focusable = container?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), select, textarea, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? container)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !container) return;

      const items = Array.from(
        container.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose, containerRef]);
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ open, onClose, title, children, actions }: DialogProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlayBehaviour(open, onClose, containerRef);

  if (!open) return null;

  return (
    <div className="scp-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={containerRef}
        className="scp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="scp-row">
          <h2 id={titleId} className="scp-dialog-title">
            {title}
          </h2>
          <span className="scp-spacer" />
          <IconButton label="Close" icon="close" onClick={onClose} />
        </div>
        <div className="scp-stack">{children}</div>
        {actions ? <div className="scp-dialog-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Confirm dialog                                                              */
/* -------------------------------------------------------------------------- */

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /** What happens - stated plainly, not "are you sure?". */
  consequence: ReactNode;
  /** Entities that stop working, enumerated. */
  affected?: string[];
  /** Irreversible actions demand typing this word. */
  confirmWord?: string;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  affected,
  confirmWord,
  confirmLabel,
  destructive = true,
  loading = false,
}: ConfirmDialogProps): JSX.Element | null {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const confirmed = !confirmWord || typed.trim().toLowerCase() === confirmWord.toLowerCase();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={() => void onConfirm()}
            disabled={!confirmed}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-line' }}>{consequence}</p>
      {affected && affected.length > 0 ? (
        <div>
          <div className="scp-hint">Affected:</div>
          <ul className="scp-stack" style={{ gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
            {affected.map((entry) => (
              <li key={entry} className="scp-mono">
                • {entry}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {confirmWord ? (
        <Input
          label={`Type "${confirmWord}" to continue`}
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      ) : null}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: 'default' | 'wide';
  footer?: ReactNode;
  children: ReactNode;
  /** Warns before closing when the form has unsaved changes. */
  dirty?: boolean;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  size = 'default',
  footer,
  children,
  dirty = false,
}: DrawerProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const requestClose = (): void => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    onClose();
  };

  useOverlayBehaviour(open, requestClose, containerRef);

  if (!open) return null;

  return (
    <div
      className="scp-drawer-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        ref={containerRef}
        className="scp-drawer"
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="scp-drawer-header">
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <h2 id={titleId} className="scp-dialog-title">
              {title}
            </h2>
            {description ? <p className="scp-card-description">{description}</p> : null}
          </div>
          <IconButton label="Close" icon="close" onClick={requestClose} />
        </header>
        <div className="scp-drawer-body">{children}</div>
        {footer ? <footer className="scp-drawer-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
