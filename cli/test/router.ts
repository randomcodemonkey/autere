/**
 * In-process mock 9router for the CLI integration tests. run.sh starts
 * this before the backend and points both at it (AUTERE_NINE_ROUTER_URL,
 * NINE_ROUTER_BASE_URL) so pi's followUp turn runs a real model call
 * against the mock — no live router or network on CI.
 *
 * Prints `ROUTER_URL=<url>` once listening, seeds pi-9router-ext's
 * discovery cache (same fixed API key the e2e harness uses), then idles
 * until killed.
 */
import { startMockRouter } from '../../cypress/e2e/support/mock-router';
import { seedRouterConfig } from '../../cypress/e2e/support/start-backend';

const mock = await startMockRouter(0);
if (!mock) {
  console.error('mock router failed to start');
  process.exit(1);
}
const url = `http://127.0.0.1:${mock.port}`;
seedRouterConfig(url);
console.log(`ROUTER_URL=${url}`);
// Keep the process (and its server) alive until run.sh kills it.
setInterval(() => {}, 1 << 30);
