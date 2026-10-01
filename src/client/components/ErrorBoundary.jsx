import { Component } from 'react';
import { Icon } from './Icons.jsx';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[client] Unhandled render error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message || String(this.state.error || 'Unknown error');
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#080b12',
          color: '#eaf0f3',
          padding: '24px',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        }}>
          <div style={{ marginBottom: '16px', color: '#c5f86a' }}>
            <Icon name="info" size={36} />
          </div>
          <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Something went wrong</h1>
          <p style={{ color: '#93a0ae', maxWidth: '460px', marginBottom: '16px', fontSize: '14px', lineHeight: '1.5' }}>
            We encountered an unexpected error while loading this page.
          </p>
          {errorMessage ? (
            <div style={{
              background: 'rgba(255, 107, 107, 0.1)',
              border: '1px solid rgba(255, 107, 107, 0.25)',
              borderRadius: '8px',
              padding: '12px 16px',
              maxWidth: '560px',
              marginBottom: '20px',
              color: '#ff8585',
              fontSize: '13px',
              fontFamily: 'monospace',
              textAlign: 'left',
              wordBreak: 'break-word',
              maxHeight: '140px',
              overflowY: 'auto'
            }}>
              <strong>Error:</strong> {errorMessage}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={() => { this.setState({ hasError: false, error: null, errorInfo: null }); }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 20px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: '#eaf0f3',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '14px'
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 20px',
                backgroundColor: '#c5f86a',
                color: '#080b12',
                borderRadius: '8px',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: '14px'
              }}
            >
              Return to catalog
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
