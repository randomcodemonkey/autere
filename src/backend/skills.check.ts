// Self-check for the per-user skills store (frontmatter, zip import, files).
// Run: npx tsx src/backend/skills.check.ts
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

// pi-env reads the env dir at module load — point it at a throwaway dir first
process.env.AUTERE_PI_ENVS_DIR = mkdtempSync(join(tmpdir(), 'autere-skills-check-'));

const {
  parseFrontmatter, unzip, importSkillZip, listSkills, skillTree, readSkillFile,
  writeSkillFile, deleteSkillFile, createSkillDir, deleteSkill, writeSkillTemplate,
  readSkillTemplate, deleteSkillTemplate, getSkillsDir,
} = await import('./skills.js');

/** Unwrap a SkillResult — the check asserts on values, not envelopes. */
const ok = <T,>(result: { data: T } | { error: string }): T => {
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result.data;
};

// ── frontmatter ──
assert.deepEqual(parseFrontmatter('---\nname: pdf-tools\ndescription: Extract PDFs.\n---\nbody'), {
  name: 'pdf-tools', description: 'Extract PDFs.',
});
assert.equal(
  parseFrontmatter('---\nname: x\ndescription: >\n  line one\n  line two\nlicense: MIT\n---\n').description,
  'line one line two',
);
assert.equal(parseFrontmatter("---\nname: 'y'\ndescription: \"quoted\"\n---\n").name, 'y');
assert.deepEqual(parseFrontmatter('no frontmatter'), {});

// ── minimal zip builder (stored + deflate) to feed the reader ──
function zip(entries: { path: string; data: Buffer; deflate?: boolean; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf-8');
    const raw = entry.data;
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    cd.writeUInt32LE(((entry.mode ?? 0o644) << 16) >>> 0, 38); // unix mode
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const archive = zip([
  { path: 'pdf-tools/SKILL.md', data: Buffer.from('---\nname: pdf-tools\ndescription: Read PDFs.\n---\n# pdf-tools\n'), deflate: true },
  { path: 'pdf-tools/scripts/extract.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
  { path: 'pdf-tools/__MACOSX/junk', data: Buffer.from('x') },
]);
assert.equal(unzip(archive).length, 3);

// ── import: wrapping dir stripped, files on disk ──
const user = 'alice';
const imported = importSkillZip(user, 'pdf-tools', 'ignored', archive.toString('base64'));
assert.ok('data' in imported && imported.data.files === 2, JSON.stringify(imported)); // __MACOSX filtered
const listed = listSkills(user).filter((s) => s.name === 'pdf-tools');
assert.equal(listed.length, 1);
assert.equal(listed[0].description, 'Read PDFs.');
assert.equal(listed[0].shared, false);
assert.ok(ok(skillTree(user, 'pdf-tools')).some((e) => e.path === 'scripts/extract.sh'));
assert.equal(statSync(join(getSkillsDir(user), 'pdf-tools/scripts/extract.sh')).mode & 0o111, 0o111, 'exec bit kept');

// ── import without SKILL.md creates one from the form ──
const bare = zip([{ path: 'notes/readme.txt', data: Buffer.from('hi') }]);
assert.ok('data' in importSkillZip(user, 'notes-skill', 'Notes helper', bare.toString('base64')));
assert.match(ok(readSkillFile(user, 'notes-skill', 'SKILL.md')).content, /description: >\n {2}Notes helper/);

// ── duplicate name, bad name, garbage archive ──
assert.equal(('error' in importSkillZip(user, 'pdf-tools', '', archive.toString('base64'))), true);
assert.equal(('error' in importSkillZip(user, 'Bad Name', '', archive.toString('base64'))), true);
assert.equal(('error' in importSkillZip(user, 'broken', '', Buffer.from('not a zip').toString('base64'))), true);

// ── files: create dir, write, escape rejection, delete ──
assert.ok('data' in createSkillDir(user, 'notes-skill', 'references'));
assert.ok('data' in writeSkillFile(user, 'notes-skill', 'references/formats.md', 'md'));
assert.equal(ok(readSkillFile(user, 'notes-skill', 'references/formats.md')).content, 'md');
assert.equal(('error' in writeSkillFile(user, 'notes-skill', '../escape.md', 'x')), true);
assert.equal(('error' in readSkillFile(user, 'notes-skill', '/etc/passwd')), true);
assert.ok('data' in deleteSkillFile(user, 'notes-skill', 'references/formats.md'));

// ── prompt template ──
assert.equal(ok(readSkillTemplate(user, 'notes-skill')).content, '');
assert.ok('data' in writeSkillTemplate(user, 'notes-skill', '---\ndescription: x\n---\nbody'));
assert.equal(ok(readSkillTemplate(user, 'notes-skill')).content.includes('body'), true);
assert.ok('data' in deleteSkillTemplate(user, 'notes-skill'));
assert.equal(ok(readSkillTemplate(user, 'notes-skill')).content, '');

// ── shared (master symlink) skills are read-only, deletable as a link ──
const master = mkdtempSync(join(tmpdir(), 'autere-skills-master-'));
mkdirSync(join(master, 'shared-skill'));
writeFileSync(join(master, 'shared-skill/SKILL.md'), '---\nname: shared-skill\ndescription: Shared.\n---\n');
symlinkSync(join(master, 'shared-skill'), join(getSkillsDir(user), 'shared-skill'), 'dir');
assert.equal(listSkills(user).find((s) => s.name === 'shared-skill')?.shared, true);
assert.equal(('error' in writeSkillFile(user, 'shared-skill', 'SKILL.md', 'x')), true);
assert.ok('data' in deleteSkill(user, 'shared-skill'));
assert.equal(listSkills(user).some((s) => s.name === 'shared-skill'), false);
assert.equal(readFileSync(join(master, 'shared-skill/SKILL.md'), 'utf-8').includes('Shared.'), true);

// ── delete ──
assert.ok('data' in deleteSkill(user, 'pdf-tools'));
assert.equal(listSkills(user).some((s) => s.name === 'pdf-tools'), false);

console.log('skills.check: ok');
