import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@scp/ui';

/**
 * Last line of defence: a rendering bug in one page must not leave the
 * operator with a blank screen.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: 'var(--space-8)' }}>
        <ErrorState
          title="This page could not be displayed"
          message="An unexpected error occurred while rendering. Reloading usually helps; if it does not, the detail below belongs in the bug report."
          detail={`${error.name}: ${error.message}`}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }
}
