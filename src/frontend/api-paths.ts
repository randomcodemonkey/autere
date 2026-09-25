/**
 * All autere API paths for the web UI — re-exported from the shared module
 * that is also the route table's source of truth on the backend. Components
 * import from here only; paths must never be written as string literals
 * elsewhere in the frontend.
 *
 * url() (from ./base-path) adds the reverse-proxy base path — wrap every
 * constant with it when building a fetch/EventSource target.
 */

import { API as SharedAPI, API_VERSION, API_PREFIX } from '../shared/api-paths';

export { API_VERSION };
export { API_PREFIX };
export const API = SharedAPI;
