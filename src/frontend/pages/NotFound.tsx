import React from 'react';
import { useNavigate } from 'react-router-dom';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div id="main-app" className="authenticated">
      <div className="container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="card" style={{ maxWidth: '400px', width: '100%' }}>
          <div className="card-header">
            <div className="card-title">404 — Not Found</div>
          </div>
          <div style={{ padding: '1rem', color: '#888', fontSize: '0.85rem', lineHeight: '1.5' }}>
            The page you are looking for does not exist or has been moved.
          </div>
          <div style={{ padding: '0 1rem 1rem' }}>
            <button className="btn btn-primary" onClick={() => navigate('/')}>
              Go Home
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
