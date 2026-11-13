/**
 * Which sessions may talk to each other (agent tools: send_to_session,
 * find_sessions, session_changes, task mutations).
 *
 * Two edges, both symmetric and depth 1 (no transitivity):
 *  - parent/child: a scheduled task's run session and the session that created
 *    it (linked when the run starts)
 *  - peers: the user paired two sessions in the Sessions view
 *
 * Stored per user in the pi env next to spawn-opts.json. This is a guardrail
 * for the tools we expose to the agent, not a security boundary: the agent
 * token identifies the user, not the session.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getPiEnvDir } from './pi-env.js';
import { log } from './logger.js';

const LINKS_FILE = 'session-links.json';
const MAX_PEERS = 50;

interface LinkEntry {
  parent?: string;
  peers?: string[];
}
type LinkStore = Record<string, LinkEntry>;

export type Relationship = 'self' | 'parent' | 'child' | 'peer';

function linksPath(user: string): string {
  return join(getPiEnvDir(user), LINKS_FILE);
}

function load(user: string): LinkStore {
  try {
    if (!existsSync(linksPath(user))) return {};
    const raw = JSON.parse(readFileSync(linksPath(user), 'utf-8'));
    return raw && typeof raw === 'object' ? raw as LinkStore : {};
  } catch {
    return {};
  }
}

function save(user: string, all: LinkStore): void {
  const clean: LinkStore = {};
  for (const [id, entry] of Object.entries(all)) {
    const peers = [...new Set((entry.peers ?? []).filter((p) => p && p !== id))].slice(0, MAX_PEERS);
    if (!entry.parent && peers.length === 0) continue;
    clean[id] = { ...(entry.parent ? { parent: entry.parent } : {}), ...(peers.length ? { peers } : {}) };
  }
  try {
    const file = linksPath(user);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(clean, null, 2));
  } catch (err) {
    log.server.warn(`Failed to persist session links for (${user}): ${err}`);
  }
}

/** A task run's session is a child of the session that created the task. */
export function linkParent(user: string, childId: string, parentId: string | undefined): void {
  if (!childId || !parentId || childId === parentId) return;
  const all = load(user);
  if (all[childId]?.parent === parentId) return;
  all[childId] = { ...(all[childId] ?? {}), parent: parentId };
  save(user, all);
}

/** Replace the sessions this one is allowed to talk to (mirrored both ways). */
export function setPeers(user: string, id: string, peers: string[]): void {
  const all = load(user);
  const wanted = new Set(peers.filter((p) => p && p !== id).slice(0, MAX_PEERS));
  const before = new Set(all[id]?.peers ?? []);
  for (const gone of before) {
    if (wanted.has(gone) || !all[gone]) continue;
    all[gone].peers = (all[gone].peers ?? []).filter((p) => p !== id);
  }
  for (const added of wanted) {
    all[added] = all[added] ?? {};
    all[added].peers = [...new Set([...(all[added].peers ?? []), id])];
  }
  all[id] = all[id] ?? {};
  all[id].peers = [...wanted];
  save(user, all);
}

/** How `a` relates to `b`, from `a`'s point of view. null = unrelated. */
export function relationship(user: string, a: string, b: string): Relationship | null {
  if (!a || !b) return null;
  if (a === b) return 'self';
  const all = load(user);
  if (all[a]?.parent === b) return 'parent';
  if (all[b]?.parent === a) return 'child';
  if (all[a]?.peers?.includes(b) || all[b]?.peers?.includes(a)) return 'peer';
  return null;
}

export function canTalk(user: string, a: string, b: string): boolean {
  return relationship(user, a, b) !== null;
}

/** Links of one session for the Sessions view. */
export function linksOf(user: string, id: string): { parent: string | null; children: string[]; peers: string[] } {
  const all = load(user);
  const children = Object.entries(all)
    .filter(([child, entry]) => entry.parent === id && child !== id)
    .map(([child]) => child);
  return {
    parent: all[id]?.parent ?? null,
    children,
    peers: all[id]?.peers ?? [],
  };
}

/** A deleted session leaves no dangling links behind. */
export function forgetSession(user: string, id: string): void {
  if (!id) return;
  const all = load(user);
  if (!all[id] && !Object.values(all).some((e) => e.parent === id || e.peers?.includes(id))) return;
  delete all[id];
  for (const [other, entry] of Object.entries(all)) {
    if (entry.parent === id) delete entry.parent;
    if (entry.peers?.includes(id)) entry.peers = entry.peers.filter((p) => p !== id);
    if (!entry.parent && !entry.peers?.length) delete all[other];
  }
  save(user, all);
}
