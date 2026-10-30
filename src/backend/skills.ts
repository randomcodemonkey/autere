/**
 * Per-user skills (Settings → Skills).
 *
 *   <pi-env>/skills/<name>/SKILL.md   skill package (files, scripts, refs)
 *   <pi-env>/prompts/<name>.md        optional prompt template (/<name>)
 *
 * ensurePiEnv materializes the shared `skills` symlink into a real directory
 * of per-entry symlinks (materializeEnvSkills), so entries that are still
 * symlinks are the SHARED master-dir skills: readable here, never writable —
 * a write would leak into every other user's env.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';
import { inflateRawSync } from 'zlib';
import { getPiEnvDir, materializeEnvSkills } from './pi-env.js';
import { under } from './files.js';
import { PI_DIR } from './constants.js';
import { log } from './logger.js';

export type SkillResult<T = any> = { data: T } | { error: string; status: number };

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_DEPTH = 8;

export interface SkillInfo {
  name: string;
  description: string;
  /** Symlink into the shared master dir — read-only for this user */
  shared: boolean;
  hasSkillMd: boolean;
  /** A prompt template exists at prompts/<name>.md */
  template: boolean;
}

export interface SkillFileInfo { path: string; type: 'file' | 'dir'; size: number }

export function validateSkillName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Skill name is required';
  const n = name.trim();
  if (n.length > 64) return 'Skill name must be at most 64 characters';
  if (!NAME_RE.test(n)) return 'Use lowercase letters, digits and hyphens only (no leading, trailing or doubled hyphens)';
  return null;
}

/** Skills root for a user; converts a legacy shared symlink on the way and
 *  seeds the shared master skills when the env was never spawned. */
export function getSkillsDir(user: string): string {
  const env = getPiEnvDir(user);
  mkdirSync(env, { recursive: true });
  const dir = join(env, 'skills');
  let present = true;
  try { lstatSync(dir); } catch { present = false; }
  if (!present) {
    // Same seeding as ensurePiEnv: link the master skills, then materialize
    try { symlinkSync(join(PI_DIR, 'skills'), dir, 'dir'); } catch { /* no master dir */ }
  }
  materializeEnvSkills(user);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function templatesDir(user: string): string {
  const dir = join(getPiEnvDir(user), 'prompts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Frontmatter name/description — enough of YAML for SKILL.md headers. */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};
  const lines = block[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    if (key !== 'name' && key !== 'description') continue;
    let value = m[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      // Folded/literal block scalar: indented continuation lines
      const parts: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function buildSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: >\n  ${description.trim()}\n---\n\n# ${name}\n`;
}

function isShared(entry: string): boolean {
  try { return lstatSync(entry).isSymbolicLink(); } catch { return false; }
}

function skillDir(user: string, name: string): string {
  return join(getSkillsDir(user), name);
}

/** Resolve a skill-relative path, refusing escapes and symlink traversal. */
function resolveInside(base: string, rel: unknown): { abs: string } | { error: string; status: number } {
  if (typeof rel !== 'string' || rel.includes('\0')) return { error: 'Invalid path', status: 400 };
  const clean = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return { error: 'Path is required', status: 400 };
  const abs = resolve(base, clean);
  if (abs === resolve(base) || !under(base, abs)) return { error: 'Path escapes the skill directory', status: 400 };
  return { abs };
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** True when the skill exists and is editable by this user (not shared). */
function editableSkill(user: string, name: string): SkillResult<{ dir: string }> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  const dir = skillDir(user, name);
  if (!exists(dir)) return { error: 'Skill not found', status: 404 };
  if (isShared(dir)) return { error: 'Shared skill — copy it to a new skill to edit it', status: 403 };
  return { data: { dir } };
}

export function listSkills(user: string): SkillInfo[] {
  const root = getSkillsDir(user);
  const out: SkillInfo[] = [];
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch (err) {
    log.skills.error(`Failed to list skills for "${user}":`, err);
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const shared = entry.isSymbolicLink();
    if (!entry.isDirectory() && !shared) continue;
    const skillMd = join(dir, 'SKILL.md');
    let meta: { name?: string; description?: string } = {};
    let hasSkillMd = false;
    try {
      const st = statSync(skillMd);
      if (st.isFile()) {
        hasSkillMd = true;
        meta = parseFrontmatter(readFileSync(skillMd, 'utf-8').slice(0, 64 * 1024));
      }
    } catch { /* no SKILL.md — pi skips it, still listed for editing */ }
    out.push({
      name: entry.name,
      description: meta.description || '',
      shared,
      hasSkillMd,
      template: exists(join(templatesDir(user), `${entry.name}.md`)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createSkill(user: string, name: unknown, description: unknown): SkillResult<SkillInfo> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  const skill = String(name).trim();
  const dir = skillDir(user, skill);
  if (exists(dir)) return { error: 'A skill with that name already exists', status: 409 };
  const desc = typeof description === 'string' ? description.trim() : '';
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), buildSkillMd(skill, desc), 'utf-8');
  } catch (e: any) {
    log.skills.error(`Failed to create skill "${skill}" for "${user}":`, e);
    return { error: `Failed to create skill: ${e.message}`, status: 500 };
  }
  return { data: { name: skill, description: desc, shared: false, hasSkillMd: true, template: false } };
}

/** Delete a skill directory; a shared symlink is only unlinked from this env. */
export function deleteSkill(user: string, name: string): SkillResult<null> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  const dir = skillDir(user, name);
  if (!exists(dir)) return { error: 'Skill not found', status: 404 };
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e: any) {
    log.skills.error(`Failed to delete skill "${name}" for "${user}":`, e);
    return { error: `Failed to delete skill: ${e.message}`, status: 500 };
  }
  return { data: null };
}

/** Recursive file list of one skill (no symlink following). */
export function skillTree(user: string, name: string): SkillResult<SkillFileInfo[]> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  const root = skillDir(user, name);
  if (!exists(root)) return { error: 'Skill not found', status: 404 };
  const out: SkillFileInfo[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) return;
    let entries: import('fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.DS_Store')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      let st: import('fs').Stats;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        out.push({ path: rel, type: 'dir', size: 0 });
        walk(abs, rel, depth + 1);
      } else {
        out.push({ path: rel, type: 'file', size: st.size });
      }
    }
  };
  walk(root, '', 0);
  return { data: out.sort((a, b) => a.path.localeCompare(b.path)) };
}

export function readSkillFile(user: string, name: string, rel: string): SkillResult<{ content: string; binary: boolean; truncated: boolean; size: number }> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  const root = skillDir(user, name);
  if (!exists(root)) return { error: 'Skill not found', status: 404 };
  const t = resolveInside(root, rel);
  if ('error' in t) return t;
  try {
    const st = statSync(t.abs);
    if (!st.isFile()) return { error: 'Not a file', status: 400 };
    const buf = readFileSync(t.abs);
    const binary = buf.subarray(0, 8192).includes(0);
    return { data: { content: binary ? '' : buf.subarray(0, MAX_FILE_BYTES).toString('utf-8'), binary, truncated: buf.length > MAX_FILE_BYTES, size: buf.length } };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Read failed: ${e.message}`, status: 500 };
  }
}

export function writeSkillFile(user: string, name: string, rel: string, content: unknown): SkillResult<null> {
  const skill = editableSkill(user, name);
  if ('error' in skill) return skill;
  if (typeof content !== 'string') return { error: 'content must be a string', status: 400 };
  const t = resolveInside(skill.data.dir, rel);
  if ('error' in t) return t;
  try {
    if (lstatSync(t.abs, { throwIfNoEntry: false })?.isSymbolicLink()) return { error: 'Refusing to write through a symlink', status: 400 };
    mkdirSync(resolve(t.abs, '..'), { recursive: true });
    writeFileSync(t.abs, content, 'utf-8');
  } catch (e: any) {
    log.skills.error(`Failed to write ${t.abs} for "${user}":`, e);
    return { error: `Write failed: ${e.message}`, status: 500 };
  }
  return { data: null };
}

export function deleteSkillFile(user: string, name: string, rel: string): SkillResult<null> {
  const skill = editableSkill(user, name);
  if ('error' in skill) return skill;
  const t = resolveInside(skill.data.dir, rel);
  if ('error' in t) return t;
  if (!exists(t.abs)) return { error: 'Not found', status: 404 };
  try {
    rmSync(t.abs, { recursive: true, force: true });
  } catch (e: any) {
    return { error: `Delete failed: ${e.message}`, status: 500 };
  }
  return { data: null };
}

export function createSkillDir(user: string, name: string, rel: string): SkillResult<null> {
  const skill = editableSkill(user, name);
  if ('error' in skill) return skill;
  const t = resolveInside(skill.data.dir, rel);
  if ('error' in t) return t;
  try {
    mkdirSync(t.abs, { recursive: true });
  } catch (e: any) {
    return { error: `Failed to create folder: ${e.message}`, status: 500 };
  }
  return { data: null };
}

// ── Prompt templates (pi reads <agent dir>/prompts/*.md as /<name>) ──

export function readSkillTemplate(user: string, name: string): SkillResult<{ content: string }> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  try {
    return { data: { content: readFileSync(join(templatesDir(user), `${name}.md`), 'utf-8') } };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { data: { content: '' } };
    return { error: `Read failed: ${e.message}`, status: 500 };
  }
}

export function writeSkillTemplate(user: string, name: string, content: unknown): SkillResult<null> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  if (typeof content !== 'string') return { error: 'content must be a string', status: 400 };
  try {
    writeFileSync(join(templatesDir(user), `${name}.md`), content, 'utf-8');
  } catch (e: any) {
    return { error: `Write failed: ${e.message}`, status: 500 };
  }
  return { data: null };
}

export function deleteSkillTemplate(user: string, name: string): SkillResult<null> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  try {
    rmSync(join(templatesDir(user), `${name}.md`), { force: true });
  } catch (e: any) {
    return { error: `Delete failed: ${e.message}`, status: 500 };
  }
  return { data: null };
}

// ── Zip packages ───────────────────────────────────

/**
 * Minimal zip reader (stored + deflate, no zip64/encryption).
 * ponytail: enough for skill packages; swap in a zip lib if zip64 or
 * encrypted archives ever matter.
 */
export function unzip(buf: Buffer): { path: string; data: Buffer; mode?: number }[] {
  const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buf.lastIndexOf(EOCD);
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: { path: string; data: Buffer; mode?: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    // Unix mode lives in the high 16 bits of the external attributes
    const mode = (buf.readUInt32LE(off + 38) >>> 16) & 0o777;
    const name = buf.toString('utf-8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.push({ path: name, data: raw, mode });
    else if (method === 8) out.push({ path: name, data: inflateRawSync(raw), mode });
    else throw new Error(`Unsupported zip compression (method ${method}) for ${name}`);
  }
  return out;
}

/** Import a skill package: extract the archive into skills/<name>.
 *  A single wrapping directory is stripped; SKILL.md is created when the
 *  archive has none, using the name/description from the form. */
export function importSkillZip(user: string, name: unknown, description: unknown, zipBase64: unknown): SkillResult<{ files: number }> {
  const err = validateSkillName(name);
  if (err) return { error: err, status: 400 };
  if (typeof zipBase64 !== 'string' || !zipBase64) return { error: 'zip (base64) is required', status: 400 };
  const skill = String(name).trim();
  const dir = skillDir(user, skill);
  if (exists(dir)) return { error: 'A skill with that name already exists', status: 409 };
  const buf = Buffer.from(zipBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length < 22) return { error: 'Empty or invalid archive', status: 400 };

  let entries: { path: string; data: Buffer; mode?: number }[];
  try {
    entries = unzip(buf).filter((e) => {
      const parts = e.path.split('/');
      return !parts.includes('__MACOSX') && parts[parts.length - 1] !== '.DS_Store';
    });
  } catch (e: any) {
    return { error: `Invalid zip archive: ${e.message}`, status: 400 };
  }
  if (!entries.length) return { error: 'The archive contains no files', status: 400 };

  // Strip one shared top-level directory (common zip layouts)
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  if (tops.size === 1 && entries.every((e) => e.path.includes('/'))) {
    entries = entries.map((e) => ({ ...e, path: e.path.slice(e.path.indexOf('/') + 1) }));
  }

  const tmp = `${dir}.import-${randomUUID()}`;
  try {
    for (const entry of entries) {
      const t = resolveInside(tmp, entry.path);
      if ('error' in t) throw Object.assign(new Error(t.error), { status: 400 });
      mkdirSync(resolve(t.abs, '..'), { recursive: true });
      writeFileSync(t.abs, entry.data);
      // Keep executable bits of packaged scripts
      if (entry.mode && entry.mode & 0o111) chmodSync(t.abs, entry.mode);
    }
    if (!exists(join(tmp, 'SKILL.md'))) {
      const desc = typeof description === 'string' ? description.trim() : '';
      writeFileSync(join(tmp, 'SKILL.md'), buildSkillMd(skill, desc), 'utf-8');
    }
    renameSync(tmp, dir);
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    log.skills.error(`Failed to import skill "${skill}" for "${user}":`, e);
    return { error: `Import failed: ${e.message}`, status: e.status || 500 };
  }
  return { data: { files: entries.length } };
}
