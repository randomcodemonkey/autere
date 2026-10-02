import { join, dirname } from 'path';
import { writeFileSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { readJsonCached, invalidateCache } from './user-settings.js';
import { getPiEnvDir } from './pi-env.js';

/**
 * Per-user MCP server configuration (pi 1.0 mcp.json). Each user's pi env
 * has its own mcp.json, seeded from the master ~/.pi/agent/mcp.json by
 * ensurePiEnv (SEED_FILES); these helpers read/write that env copy.
 */
export interface McpServerConfig {
  /** stdio */ command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http */ url?: string;
  headers?: Record<string, string>;
  description?: string;
  exposure?: 'codemode' | 'deferred' | 'direct' | 'hidden';
  toolExposure?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

const validName = (name: string) => /^[A-Za-z0-9_-]+$/.test(name);
const VALID_EXPOSURES = new Set(['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']);

function mcpPath(user: string): string {
  return join(getPiEnvDir(user), 'mcp.json');
}

function readMcp(user: string): Record<string, McpServerConfig> {
  const raw = readJsonCached(mcpPath(user));
  const servers = raw?.mcpServers;
  return servers && typeof servers === 'object' ? servers : {};
}

function writeMcp(user: string, servers: Record<string, McpServerConfig>): void {
  const p = mcpPath(user);
  const tmp = join(dirname(p), `.mcp-tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');
  renameSync(tmp, p);
  invalidateCache(p);
}

/** Validation shared by create and update. Throws with a user-facing message. */
export function validateMcpServer(server: McpServerConfig): void {
  if (!server || typeof server !== 'object') throw new Error('Server config must be an object');
  const hasCommand = typeof server.command === 'string' && server.command.trim() !== '';
  const hasUrl = typeof server.url === 'string' && server.url.trim() !== '';
  if (hasCommand === hasUrl) throw new Error('Exactly one of command (stdio) or url (http) is required');
  if (server.exposure !== undefined && !VALID_EXPOSURES.has(String(server.exposure))) {
    throw new Error(`exposure must be one of ${[...VALID_EXPOSURES].join(', ')}`);
  }
}

export function getMcpServers(user: string): Record<string, McpServerConfig> {
  // Strip env values — runtime may expand ${VAR}/!command secrets; the UI
  // gets the shape, not resolved values (values are echoed as configured).
  return readMcp(user);
}

export function setMcpServer(user: string, name: string, server: McpServerConfig): void {
  if (!validName(name)) throw new Error('Server name may contain only letters, digits, _ and -');
  validateMcpServer(server);
  const servers = readMcp(user);
  servers[name] = server;
  writeMcp(user, servers);
}

export function deleteMcpServer(user: string, name: string): boolean {
  const servers = readMcp(user);
  if (!(name in servers)) return false;
  delete servers[name];
  writeMcp(user, servers);
  return true;
}

/** Replace the whole mcpServers map (settings page save); validates every entry. */
export function replaceMcpServers(user: string, servers: Record<string, McpServerConfig>): void {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!validName(name)) throw new Error(`Invalid server name: ${name}`);
    validateMcpServer(server);
    out[name] = server;
  }
  writeMcp(user, out);
}
