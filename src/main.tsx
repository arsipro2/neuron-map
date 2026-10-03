import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Neuron Map crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ width: '100%', height: '100%', display: 'grid', placeContent: 'center', gap: 12, padding: 32, background: '#090d15', color: '#eef2ff', fontFamily: 'system-ui, sans-serif' }}>
          <strong style={{ fontSize: 20 }}>Neuron Map encountered an interface error</strong>
          <span style={{ maxWidth: 760, color: '#aab4c8', lineHeight: 1.5 }}>{this.state.error.message}</span>
          <button style={{ justifySelf: 'start', padding: '8px 12px', borderRadius: 8, border: '1px solid #3b4862', background: '#171f2d', color: '#eef2ff', cursor: 'pointer' }} onClick={() => window.location.reload()}>Reload</button>
        </main>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)
