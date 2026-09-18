import { Component, ErrorInfo, ReactNode } from 'react';
import { diagnostics } from '../core/diagnostics';

interface Props {
  sessionId: string;
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-pane error boundary isolating render explosions to the individual pane leaf.
 * Guarantees Invariant F1 (Containment): a corrupted row or DOM error inside one
 * pane can never crash sibling panes, the layout, or the persistent status plate.
 */
export class PaneErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    diagnostics.record({
      kind: 'transition',
      name: 'render:error',
      sessionId: this.props.sessionId,
      requestId: null,
      reason: error.message || 'Unknown render error',
    });
    diagnostics.count('attachmentsFaulted');
    console.error(`[PaneErrorBoundary] Caught error in pane ${this.props.sessionId}:`, error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-testid="pane-render-error"
          className="flex-1 flex flex-col items-center justify-center p-6 recess select-none"
          style={{
            backgroundColor: '#14120f',
            boxShadow: 'var(--bevel-dn, inset 1px 1px 0 #171716, inset -1px -1px 0 #8e8e8b)',
            borderRadius: 0,
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: 'var(--st-fail, #ef4136)', fontWeight: 'bold' }}>✖ RENDER FAULT</span>
            <span className="text-xs uppercase" style={{ color: 'var(--st-idle, #847c6e)' }}>
              PANE [{this.props.sessionId}]
            </span>
          </div>

          <div
            className="p-3 mb-4 max-w-md w-full font-mono text-xs overflow-auto"
            style={{
              backgroundColor: '#0a0908',
              color: '#d0cfc9',
              boxShadow: 'var(--bevel-dn)',
              borderRadius: 0,
            }}
          >
            {this.state.error?.message || 'Uncaught render exception'}
          </div>

          <button
            type="button"
            onClick={this.handleRetry}
            className="px-4 py-2 font-mono text-xs tracking-wider uppercase transition-colors"
            style={{
              backgroundColor: '#2f2f2e',
              color: '#f0ece1',
              boxShadow: 'var(--bevel-up, inset 1px 1px 0 #a2a29f, inset -1px -1px 0 #2f2f2e)',
              borderRadius: 0,
            }}
          >
            RETRY RENDER
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
