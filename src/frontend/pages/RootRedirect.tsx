import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { API } from '../api-paths';
import { apiJSON, apiBody, JSON_HEADERS } from '../api';
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

    const loadSessions = async (attempt: number): Promise<void> => {
      let sessions: { id: string }[];
      try {
        sessions = (await apiJSON<{ id: string }[]>(API.sessions.list)) || [];
      } catch {
        // A rejected fetch here is usually the page navigating away (the
        // next visit aborts this request) — the retry dies with the view,
        // so nothing is stashed. Two rejections while the view lives is a
        // real failure: surface it.
        if (attempt < 1) setTimeout(() => loadSessions(attempt + 1), 300);
        else { stash('Failed to load sessions.'); nav('/session/-'); }
        return;
      }
      if (sessions.length > 0) {
        // Pick the most recently active session
        nav(`/session/${sessions[0].id}`);
        return;
      }
      // No sessions available — create one and go to it. On failure (e.g.
      // sandbox/docker unavailable) the app MUST still load: stash the reason
      // for the error modal and land in the chat view, so the user can reach
      // settings (turn the sandbox off) etc.
      try {
        const created = await apiBody(API.sessions.list, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            sessionName: uiSessionName(),
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });
        if (created?.navigateUrl) nav(created.navigateUrl);
        else { stash('No sessions available. Create one from the chat.'); nav('/session/-'); }
      } catch (err: any) {
        stash(err.message || 'Failed to create session.');
        nav('/session/-');
      }
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
