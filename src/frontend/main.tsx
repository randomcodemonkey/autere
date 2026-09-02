import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { basePath, url } from './base-path';
import './styles.scss';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basePath()}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// ── Service worker: keeps home-screen (standalone) web apps up to date ──
// The SW uses a network-first strategy for the app shell, so once installed
// every deployment wins over cached assets. We additionally check for SW
// updates periodically and whenever the page becomes visible again, and
// reload once when a new version takes control — so a home-screen app picks
// up new code without closing and reopening it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url('/sw.js')).then((reg) => {
      // Check for a new worker on visibility change and every 60s
      const check = () => { reg.update().catch(() => {}); };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, 60_000);

      // NOTE: no auto-reload on controllerchange. An automatic reload was
      // attempted but proved to fire spuriously (mid-session), killing open
      // state like the sessions modal. New deployments reach standalone
      // home-screen apps on their next app open (the SW is network-first),
      // and the System card's 'Reload UI' button forces it immediately.
    }).catch(() => {
      // SW unsupported/blocked (e.g. insecure context) — app works as before
    });
  });
}
