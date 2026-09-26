import { Component, type ErrorInfo, type ReactNode } from 'react'

import { ErrorBox } from './primitives'

/** Contains render failures to the page that raised them; the header and wallet controls stay usable. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[bucket] render error', error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="page">
          <ErrorBox error={this.state.error} />
        </main>
      )
    }
    return this.props.children
  }
}
