import { Component } from 'react';
import { Btn } from './UI';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-zinc-950 p-6">
          <div className="max-w-md text-center space-y-4">
            <div className="text-5xl">⚠️</div>
            <h1 className="text-xl font-semibold text-zinc-100">Something went wrong</h1>
            <p className="text-sm text-zinc-400">{this.state.error?.message || 'An unexpected error occurred.'}</p>
            <Btn onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}>
              Reload App
            </Btn>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.pageKey !== this.props.pageKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  /**
   * Say WHERE it broke, not just that it broke.
   *
   * The screen showed only error.message, so "Cannot access 'basePhotoPairs' before
   * initialization" arrived with no file, no line, and no component -- and three separate
   * crashes were diagnosed by reading source instead of reading the error (2026-08-09 x2,
   * 2026-08-10). The stack is what turns a report of "page crashed" into a location.
   */
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[page crash]', error, info?.componentStack);
    this.setState({ info });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center py-24">
          <div className="max-w-md text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <h2 className="text-lg font-semibold text-zinc-100">This page crashed</h2>
            <p className="text-sm text-zinc-400">{this.state.error?.message || 'An unexpected error occurred.'}</p>
            {/* Collapsed, because the message is what most people need -- but present, because
                without it the only way to locate a crash is to re-read the source. */}
            {(this.state.error?.stack || this.state.info?.componentStack) && (
              <details className="text-left">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">Show details</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 text-[10px] leading-relaxed text-zinc-400">
                  {String(this.state.error?.stack || '')}
                  {String(this.state.info?.componentStack || '')}
                </pre>
                <button
                  type="button"
                  className="mt-2 text-xs text-zinc-500 underline hover:text-zinc-300"
                  onClick={() => navigator.clipboard?.writeText(
                    `${this.state.error?.stack || this.state.error?.message || ''}${this.state.info?.componentStack || ''}`,
                  )}
                >
                  Copy
                </button>
              </details>
            )}
            <Btn onClick={() => this.setState({ hasError: false, error: null, info: null })}>
              Try Again
            </Btn>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
