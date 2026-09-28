import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { url } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';

export function RootRedirect() {
  const navigate = useNavigate();
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
          // No sessions available — create one and go to it. On failure
          // (e.g. sandbox/docker unavailable) the app MUST still load: stash
          // the reason for the error modal and land in the chat view, so the
          // user can reach settings (turn the sandbox off) etc.
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
                sessionStorage.setItem('bootstrapError', d.error || 'No sessions available. Create one from the chat.');
                navigate('/session/-', { replace: true });
              }
            })
            .catch(() => {
              sessionStorage.setItem('bootstrapError', 'Failed to create session.');
              navigate('/session/-', { replace: true });
            });
        } else {
          // Request failed (e.g. not authenticated yet) — surface the error
          sessionStorage.setItem('bootstrapError', 'Failed to load sessions.');
          navigate('/session/-', { replace: true });
        }
      })
      .catch(() => {
        sessionStorage.setItem('bootstrapError', 'Failed to load sessions.');
        navigate('/session/-', { replace: true });
      });
  }, [navigate]);

  return (
    <div id="main-app" className="authenticated">
      <div className="settings-page">
        <div className="settings-loading">Loading…</div>
      </div>
    </div>
  );
}
