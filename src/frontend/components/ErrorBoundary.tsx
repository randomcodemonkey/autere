/**
 * Error boundary — any unhandled render/runtime error (and failed lazy
 * chunk loads, e.g. a stale service-worker holding an old asset manifest)
 * shows a clean card instead of a blank page. The type label helps decide
 * instantly whether a reload fixes it (chunk mismatch) or details matter.
 *   key={<view>} remounts a boundary per section so one bad card doesn't
 *   take down the whole app.
 */
import React from 'react';

interface State {
  error: unknown;
}

export default class ErrorBoundary extends React.Component<{
  children: React.ReactNode;
  /** Section name shown in the fallback header. */
  name: string;
  /** Root boundary: full-screen fallback — nothing else renders. */
  isRoot?: boolean;
}, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`[autere] ${this.props.name} crashed:`, error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error instanceof Error
      ? this.state.error.message
      : String(this.state.error);
    const staleChunk = /Failed to fetch dynamically imported module|Unable to preload CSS|Loading CSS chunk|error loading dynamically imported/i.test(msg);
    if (this.props.isRoot) {
      return (
        <div role="alert" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--c-bg, #101014)', color: 'var(--c-text, #eaeaea)', padding: '1.5rem' }}>
          <div style={{ maxWidth: '36rem', width: '100%', textAlign: 'center' }}>
            <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
            <div style={{ wordBreak: 'break-word', marginBottom: '1rem', fontSize: '.9rem' }}>{msg}</div>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return (
      <div className="card error-boundary-card" role="alert">
        <div className="card-title">{this.props.name} failed to render</div>
        <div className="error-boundary-message">{msg}</div>
        <div className="btn-group">
          <button
            className="btn btn-primary"
            onClick={() => {
              if (staleChunk) {
                // Stale hashed asset — the running code no longer matches the
                // served assets; a location reload (not a SPA remount) is the
                // only reliable cure.
                window.location.reload();
                return;
              }
              this.setState({ error: null });
            }}
          >
            {staleChunk ? 'Reload page' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }
}
