/**
 * Agent personas — named system prompts users can bind to sessions.
 *
 * Library:  <pi-env>/personas.json       — Persona[]
 * Bindings: <pi-env>/persona-active.json — { [sessionFileName]: Persona }
 *
 * The bindings file is shared with the pi-personas extension (extras/),
 * which puts the bound persona into the system prompt every turn and emits
 * visible transition markers (see extras/pi-personas/index.ts).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import { getPiEnvDir } from './pi-env.js';
import { log } from './logger.js';

export interface Persona {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

function libraryPath(user: string): string {
  return join(getPiEnvDir(user), 'personas.json');
}

function bindingsPath(user: string): string {
  return join(getPiEnvDir(user), 'persona-active.json');
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeJson(path: string, data: any): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    log.settings.error(`Failed to write ${basename(path)}:`, err);
  }
}

export function listPersonas(user: string): Persona[] {
  const list = readJson(libraryPath(user));
  return Array.isArray(list) ? list.filter((p: any) => p && typeof p.id === 'string') : [];
}

export function savePersonas(user: string, personas: Persona[]): void {
  writeJson(libraryPath(user), personas);
}

/** Validate user-supplied persona input; returns an error message or null */
export function validatePersona(input: any): string | null {
  if (!input || typeof input !== 'object') return 'Persona must be an object';
  if (typeof input.name !== 'string' || !input.name.trim()) return 'Name is required';
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return 'Prompt is required';
  return null;
}

/** Active persona for a session file path, or null */
export function getActivePersona(user: string, sessionFile: string | null | undefined): Persona | null {
  if (!sessionFile) return null;
  const bindings = readJson(bindingsPath(user));
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const p = bindings[basename(sessionFile)];
  return p && typeof p.prompt === 'string' && p.prompt.trim() ? p : null;
}

/** Bind (or unbind, with null) a persona to a session file */
export function setActivePersona(user: string, sessionFile: string, persona: Persona | null): void {
  const bindings = readJson(bindingsPath(user));
  const map = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {};
  const key = basename(sessionFile);
  if (persona) map[key] = persona;
  else delete map[key];
  writeJson(bindingsPath(user), map);
}
