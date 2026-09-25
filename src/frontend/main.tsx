import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { basePath, url } from './base-path';
import { getClientId, CLIENT_ID_HEADER } from './client-id';
import './styles.scss';

// Stamp every same-origin API/SSE request with this tab's client id — the
// backend routes streaming events and session calls by it. A wrapper here
// means no call site needs to know about it.
const origFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const api = target.includes('/api/');
  if (api) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set(CLIENT_ID_HEADER, getClientId());
    return origFetch(input, { ...init, headers });
  }
  return origFetch(input, init);
};

declare const __BUILD_ID__: string;
 
console.log(`[autere] UI build ${__BUILD_ID__}`);

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
        if (document.visibilityState === 'visible') {
          // Update FIRST, before the app reacts to visibility (SSE wake
          // reconnect) — otherwise a resumed page reconnects on old code
          // and then reloads mid-stream when the new worker takes control.
          check();
        }
      });
      // iOS standalone PWAs sometimes skip visibilitychange on snapshot
      // resume — pageshow is the reliable signal there.
      window.addEventListener('pageshow', check);
      setInterval(check, 60_000);

      // When a NEW worker takes control (i.e. an update was installed),
      // reload once so the page runs the fresh code. On first install the
      // worker claims the page and ALSO fires controllerchange — that must
      // NOT reload (it would reload every page load a few seconds in), so
      // track whether a controller existed before the change. Without this
      // reload, a resumed mobile PWA webview keeps running old assets
      // indefinitely (no navigation happens on resume).
      let hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
          hadController = true; // first install/claim — not an update
          return;
        }
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }).catch(() => {
      // SW unsupported/blocked (e.g. insecure context) — app works as before
    });
  });
}
