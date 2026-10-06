import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { url } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';

export function RootRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    // A fetch aborted by this view going away must not leave a sticky error
    // behind: `alive` dies with the view, so retries/navigations/stashes from
    // the straggler are dropped instead of surfacing as a blocking modal on
    // whichever page loads next.
    let alive = true;
    const nav = (to: string) => { if (alive) navigate(to, { replace: true }); };
    const stash = (msg: string) => { if (alive) sessionStorage.setItem('bootstrapError', msg); };

    const loadSessions = (attempt: number): void => {
      fetch(url(API.sessions.list))
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data && data.data.length > 0) {
            // Pick the most recently active session
            const latest = data.data[0];
            nav(`/session/${latest.id}`);
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
                  nav(d.navigateUrl);
                } else {
                  stash(d.error || 'No sessions available. Create one from the chat.');
                  nav('/session/-');
                }
              })
              .catch(() => {
                stash('Failed to create session.');
                nav('/session/-');
              });
          } else if (attempt < 1) {
            // One retry: a transient failure (half-written seed file, blip)
            // must not become a sticky blocking error modal on the next page.
            setTimeout(() => loadSessions(attempt + 1), 300);
          } else {
            // Request failed (e.g. not authenticated yet) — surface the error
            stash('Failed to load sessions.');
            nav('/session/-');
          }
        })
        .catch(() => {
          // A rejected fetch here is usually the page navigating away (the
          // next visit aborts this request) — the retry dies with the view,
          // so nothing is stashed. Two rejections while the view lives is a
          // real failure: surface it.
          if (attempt < 1) setTimeout(() => loadSessions(attempt + 1), 300);
          else {
            stash('Failed to load sessions.');
            nav('/session/-');
          }
        });
    };
    loadSessions(0);
    return () => { alive = false; };
  }, [navigate]);

  return (
    <div id="main-app" className="authenticated">
      <div className="settings-page">
        <div className="settings-loading">Loading…</div>
      </div>
    </div>
  );
}
