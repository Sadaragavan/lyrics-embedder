import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  errorInfo: ErrorInfo | null
}

/**
 * Last-resort renderer error boundary.
 *
 * A render-time exception anywhere below this boundary would otherwise blank the
 * window (for example the React #310 hook-order crash). This surfaces a readable
 * message plus a Reload button so the user is never left with a white screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ error, errorInfo })
    // Surface the failure in the DevTools console for diagnostics.
    console.error('Renderer crashed:', error, errorInfo)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleDismiss = (): void => {
    this.setState({ error: null, errorInfo: null })
  }

  render(): ReactNode {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-zinc-950 p-8 text-zinc-100"
      >
        <div className="flex max-w-xl flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-zinc-400">
            The lyrics editor hit an unexpected error and stopped rendering. Your saved drafts
            are untouched. Reload the window to recover.
          </p>
          <pre className="max-h-40 w-full overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 text-left font-mono text-[11px] leading-relaxed text-red-300">
            {error.message}
            {errorInfo?.componentStack ? `\n${errorInfo.componentStack}` : ''}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
            >
              <RotateCcw className="h-4 w-4" />
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleDismiss}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    )
  }
}