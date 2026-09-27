import { Component } from 'react';
import { Icon } from './Icons.jsx';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[client] Unhandled render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
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
          <p style={{ color: '#93a0ae', maxWidth: '420px', marginBottom: '24px', fontSize: '14px', lineHeight: '1.5' }}>
            We encountered an unexpected error while loading this page.
          </p>
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
      );
    }
    return this.props.children;
  }
}
