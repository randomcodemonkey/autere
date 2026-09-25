import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // Build timestamp, surfaced in the System card and console so a client
    // can verify which UI version it is running (stale-PWA debugging).
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
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
