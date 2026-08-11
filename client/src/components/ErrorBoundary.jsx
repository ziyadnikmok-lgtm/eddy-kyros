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
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.pageKey !== this.props.pageKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center py-24">
          <div className="max-w-md text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <h2 className="text-lg font-semibold text-zinc-100">This page crashed</h2>
            <p className="text-sm text-zinc-400">{this.state.error?.message || 'An unexpected error occurred.'}</p>
            <Btn onClick={() => this.setState({ hasError: false, error: null })}>
              Try Again
            </Btn>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
