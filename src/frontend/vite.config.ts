import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
// autere release-version from package.json (shown in the System card alongside
// the UI build id). readFileSync instead of a JSON import — esbuild config
// loader resolves relative JSON imports against the CWD, not our repo root.
const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).version as string;

export default defineConfig({
  plugins: [react()],
  experimental: {
    // Runtime base: the app runs behind a reverse proxy with a path prefix.
    // The backend injects window.__AUTERE_BASE__ into index.html and rewrites
    // absolute HTML asset refs; but Vite's dynamic-import preload helper bakes
    // URLs into JS at build time, so they must resolve the prefix at runtime.
    renderBuiltUrl(filename, host) {
      if (host.hostType === 'js') {
        return { runtime: `(window.__AUTERE_BASE__||'')+${JSON.stringify('/' + filename)}` };
      }
      return undefined; // HTML/CSS refs stay absolute; backend rewrites index.html
    },
  },
  define: {
    // Build timestamp, surfaced in the System card and console so a client
    // can verify which UI version it is running (stale-PWA debugging).
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
    // autere release version (package.json), shown next to it
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  root: '.',
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3456',
    },
  },
});
