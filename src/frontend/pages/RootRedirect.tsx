import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { url } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';

export function RootRedirect() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Try to find the last active session, then navigate to it
    fetch(url(API.sessions.list))
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data && data.data.length > 0) {
          // Pick the most recently active session
          const latest = data.data[0];
          navigate(`/session/${latest.id}`, { replace: true });
        } else if (data.success) {
          // No sessions available — create one and go to it
          fetch(url(API.sessions.list), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionName: uiSessionName(),
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          })
            .then(res => res.json())
            .then(d => {
              if (d.success && d.navigateUrl) {
                navigate(d.navigateUrl, { replace: true });
              } else {
                setError(d.error || 'No sessions available. Create one from the chat.');
              }
            })
            .catch(() => setError('Failed to create session.'));
        } else {
          // Request failed (e.g. not authenticated yet) — surface the error
          setError('Failed to load sessions.');
        }
      })
      .catch(() => setError('Failed to load sessions.'));
  }, [navigate]);

  if (error) {
    return (
      <div id="main-app" className="authenticated">
        <div className="settings-page">
          <div className="settings-empty">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div id="main-app" className="authenticated">
      <div className="settings-page">
        <div className="settings-loading">Loading…</div>
      </div>
    </div>
  );
}
