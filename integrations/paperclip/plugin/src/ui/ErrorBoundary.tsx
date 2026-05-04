import * as React from "react";

/**
 * Class-based error boundary. Wraps every top-level slot component so a
 * render error in our code falls back to a small message instead of
 * crashing the host.
 *
 * The SDK's @paperclipai/plugin-sdk/ui does NOT re-export ErrorBoundary
 * from its index (FEASIBILITY §4) — it lives in ui/components.ts only,
 * and the package exports map doesn't surface it. Rolling our own is
 * trivial and removes a brittle deep-import.
 */

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="llm-wiki-error-boundary" role="alert">
          <strong>Something went wrong rendering this section.</strong>
          <div className="llm-wiki-error-message">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
