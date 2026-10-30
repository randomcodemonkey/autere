import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API } from '../api-paths';
import { apiJSON, apiSend, JSON_HEADERS } from '../api';
import { DataTable, TD } from './DataTable';
import { Modal } from './Modal';

interface SkillInfo {
  name: string;
  description: string;
  shared: boolean;
  hasSkillMd: boolean;
  template: boolean;
}

interface SkillFile { path: string; type: 'file' | 'dir'; size: number }

const NAME_HINT = 'lowercase letters, digits and hyphens';

/** Base64 (no data: prefix) of a picked file — the import endpoint takes JSON. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the archive'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Skeleton for a skill's prompt template (pi's <name>.md frontmatter). */
function templateSkeleton(skill: SkillInfo): string {
  const description = skill.description || `Prompt template for the ${skill.name} skill`;
  return `---\ndescription: ${description}\nargument-hint: "[request]"\n---\n`;
}

/**
 * Settings -> Skills: per-user skill packages under <pi-env>/skills/<name>
 * (SKILL.md + files) and the optional prompt template <pi-env>/prompts/
 * <name>.md. Skills symlinked from the shared master dir are read-only.
 */
export const SkillsSection: React.FC = () => {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'create' | 'import' | null>(null);
  const [editing, setEditing] = useState<SkillInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setSkills(await apiJSON<SkillInfo[]>(API.skills.root) || []);
    } catch (err: any) {
      setError(`Failed to load skills: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (skill: SkillInfo) => {
    const sharedNote = skill.shared ? ' It is a shared skill — only your link to it is removed.' : '';
    if (!window.confirm(`Delete skill “${skill.name}”?${sharedNote}`)) return;
    try {
      await apiSend(API.skills.item(skill.name), 'DELETE');
      await load();
    } catch (err: any) {
      setError(`Failed to delete skill: ${err.message}`);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">Skills</h3>
        <div className="skills-head-actions">
          <button className="btn" type="button" onClick={() => { setError(null); setForm('import'); }}>Import</button>
          <button className="btn btn-primary" type="button" onClick={() => { setError(null); setForm('create'); }}>New skill</button>
        </div>
      </div>
      <div className="settings-description">
        Skill packages are loaded by pi at session start from your own skills folder. A skill can also
        provide a prompt template, available as <code>/&lt;skill-name&gt;</code>.
      </div>
      {error && <div className="settings-error">{error}</div>}

      {loading ? (
        <div className="settings-loading">Loading…</div>
      ) : skills.length === 0 ? (
        <div className="settings-empty">No skills yet.</div>
      ) : (
        <DataTable columns={[
          { key: 'name', label: 'Skill' },
          { key: 'description', label: 'Description' },
          { key: 'template', label: 'Command' },
          { key: 'actions', label: '' },
        ]}>
          {skills.map((skill) => (
            <tr key={skill.name} className="skills-row">
              <TD label="Skill">
                <span className="skills-name">{skill.name}</span>
                {skill.shared && <span className="skills-badge">shared</span>}
                {!skill.hasSkillMd && <span className="skills-badge skills-badge-warn">no SKILL.md</span>}
              </TD>
              <TD label="Description"><span className="skills-desc">{skill.description || '—'}</span></TD>
              <TD label="Command">{skill.template ? <code>/{skill.name}</code> : '—'}</TD>
              <TD label="">
                <div className="skills-row-actions">
                  <button className="btn btn-sm" type="button" onClick={() => { setError(null); setEditing(skill); }}>Edit</button>
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => remove(skill)}>Delete</button>
                </div>
              </TD>
            </tr>
          ))}
        </DataTable>
      )}

      {form && (
        <SkillFormModal
          mode={form}
          onClose={() => setForm(null)}
          onDone={() => { setForm(null); load(); }}
        />
      )}

      {editing && (
        <SkillEditModal
          skill={editing}
          onClose={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
};

/** Create / import dialog — name + description always, the archive for import. */
const SkillFormModal: React.FC<{ mode: 'create' | 'import'; onClose: () => void; onDone: () => void }> = ({ mode, onClose, onDone }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [zip, setZip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  const isImport = mode === 'import';
  const ready = !!name.trim() && (!isImport || !!zip) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (isImport) {
        const zipData = await readBase64(zip!);
        await apiJSON(API.skills.importZip, {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ name: name.trim(), description, zip: zipData }),
        });
      } else {
        await apiSend(API.skills.root, 'POST', { name: name.trim(), description });
      }
      onDone();
    } catch (err: any) {
      setError(`${isImport ? 'Import' : 'Create'} failed: ${err.message}`);
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} className="modal-skills-form">
      <div className="modal-header">
        <h3>{isImport ? 'Import skill package' : 'New skill'}</h3>
        <button className="modal-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        {error && <div className="settings-error">{error}</div>}
        <div className="settings-field">
          <label className="settings-label">Name</label>
          <input
            className="settings-input"
            type="text"
            value={name}
            spellCheck={false}
            placeholder={`e.g. pdf-tools (${NAME_HINT})`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            autoFocus
          />
        </div>
        <div className="settings-field">
          <label className="settings-label">Description</label>
          <input
            className="settings-input"
            type="text"
            value={description}
            placeholder="When the model should use this skill"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {isImport && (
          <div className="settings-field">
            <label className="settings-label">Package (.zip)</label>
            <input
              ref={zipRef}
              className="settings-input skills-file-input"
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => setZip(e.target.files?.[0] ?? null)}
            />
            <div className="settings-description">
              Extracted to <code>skills/&lt;name&gt;</code>. A <code>SKILL.md</code> is created from the name and
              description when the archive has none.
            </div>
          </div>
        )}
        <div className="btn-group">
          <button className="btn btn-primary" type="button" disabled={!ready} onClick={submit}>
            {busy ? (isImport ? 'Importing…' : 'Creating…') : (isImport ? 'Import package' : 'Create skill')}
          </button>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
};

/** Edit dialog: skill files (tree + editor) and the prompt template. */
const SkillEditModal: React.FC<{ skill: SkillInfo; onClose: () => void }> = ({ skill, onClose }) => {
  const [tab, setTab] = useState<'files' | 'template'>('files');
  const [tree, setTree] = useState<SkillFile[]>([]);
  const [path, setPath] = useState('SKILL.md');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState('');
  const [templateSaved, setTemplateSaved] = useState('');
  const [binary, setBinary] = useState(false);

  const readOnly = skill.shared;

  const loadTree = useCallback(async () => {
    try {
      setTree(await apiJSON<SkillFile[]>(API.skills.tree(skill.name)) || []);
    } catch (err: any) {
      setError(`Failed to load skill files: ${err.message}`);
    }
  }, [skill.name]);

  const loadFile = useCallback(async (file: string) => {
    try {
      const data = await apiJSON<{ content: string; binary: boolean }>(API.skills.file(skill.name, file));
      setPath(file);
      setContent(data.binary ? '' : data.content);
      setSaved(data.binary ? '' : data.content);
      setBinary(data.binary);
      setError(null);
    } catch (err: any) {
      setError(`Failed to read ${file}: ${err.message}`);
    }
  }, [skill.name]);

  useEffect(() => { loadTree(); }, [loadTree]);

  useEffect(() => {
    if (tab !== 'files') return;
    loadFile('SKILL.md');
  }, [tab, loadFile]);

  useEffect(() => {
    if (tab !== 'template') return;
    let current = true;
    apiJSON<{ content: string }>(API.skills.template(skill.name))
      .then((data) => {
        if (!current) return;
        setTemplate(data.content || templateSkeleton(skill));
        setTemplateSaved(data.content || '');
      })
      .catch((err: any) => setError(`Failed to load prompt template: ${err.message}`));
    return () => { current = false; };
  }, [tab, skill]);

  const saveFile = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiSend(API.skills.file(skill.name), 'PUT', { path, content });
      setSaved(content);
      setBinary(false);
      await loadTree();
    } catch (err: any) {
      setError(`Failed to save ${path}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async (dir: boolean) => {
    const rel = window.prompt(dir ? 'New folder path (relative to the skill)' : 'New file path (relative to the skill)');
    if (!rel || !rel.trim()) return;
    const target = rel.trim().replace(/^\/+/, '');
    try {
      if (dir) {
        await apiSend(API.skills.dir(skill.name), 'POST', { path: target });
      } else {
        await apiSend(API.skills.file(skill.name), 'PUT', { path: target, content: '' });
      }
      await loadTree();
      if (!dir) await loadFile(target);
    } catch (err: any) {
      setError(`Failed to create ${target}: ${err.message}`);
    }
  };

  const removeFile = async () => {
    if (!window.confirm(`Delete “${path}”?`)) return;
    try {
      await apiSend(API.skills.file(skill.name, path), 'DELETE');
      await loadTree();
      await loadFile('SKILL.md');
    } catch (err: any) {
      setError(`Failed to delete ${path}: ${err.message}`);
    }
  };

  const saveTemplate = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiSend(API.skills.template(skill.name), 'PUT', { content: template });
      setTemplateSaved(template);
    } catch (err: any) {
      setError(`Failed to save prompt template: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const dirty = tab === 'files' ? content !== saved : template !== templateSaved;

  return (
    <Modal open onClose={onClose} className="modal-skills-edit">
      <div className="modal-header">
        <h3>
          {skill.name}
          {skill.shared && <span className="skills-badge">shared — read-only</span>}
        </h3>
        <button className="modal-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        {error && <div className="settings-error">{error}</div>}

        <div className="skills-tabs">
          <button className={`skills-tab${tab === 'files' ? ' active' : ''}`} type="button" onClick={() => setTab('files')}>Files</button>
          <button className={`skills-tab${tab === 'template' ? ' active' : ''}`} type="button" onClick={() => setTab('template')}>
            Prompt template
          </button>
        </div>

        {tab === 'files' ? (
          <div className="skills-editor-body">
            <div className="skills-tree">
              <div className="skills-tree-actions">
                <button className="btn btn-sm" type="button" disabled={readOnly} onClick={() => addEntry(false)}>+ File</button>
                <button className="btn btn-sm" type="button" disabled={readOnly} onClick={() => addEntry(true)}>+ Folder</button>
              </div>
              {tree.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`skills-tree-item${entry.path === path ? ' active' : ''}${entry.type === 'dir' ? ' dir' : ''}`}
                  style={{ paddingLeft: `${8 + entry.path.split('/').length * 10}px` }}
                  onClick={() => { if (entry.type === 'file') loadFile(entry.path); }}
                >
                  {entry.type === 'dir' ? '▸ ' : ''}{entry.path.split('/').pop()}
                </button>
              ))}
            </div>
            <div className="skills-file">
              <div className="skills-file-head">
                <code>{path}</code>
                <div className="skills-file-actions">
                  <button className="btn btn-sm btn-primary" type="button" disabled={readOnly || busy || !dirty || binary} onClick={saveFile}>Save</button>
                  <button className="btn btn-sm btn-danger" type="button" disabled={readOnly || path === 'SKILL.md'} onClick={removeFile}>Delete</button>
                </div>
              </div>
              {binary ? (
                <div className="settings-empty">Binary file — not editable.</div>
              ) : (
                <textarea
                  className="settings-input skills-textarea"
                  value={content}
                  spellCheck={false}
                  readOnly={readOnly}
                  onChange={(e) => setContent(e.target.value)}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="skills-file">
            <div className="settings-description">
              Prompt template for this skill, loaded by pi as <code>/{skill.name}</code>. Arguments after the
              command are appended to the prompt.
            </div>
            <div className="skills-file-head">
              <code>prompts/{skill.name}.md</code>
              <div className="skills-file-actions">
                <button className="btn btn-primary" type="button" disabled={busy || !dirty} onClick={saveTemplate}>Save template</button>
              </div>
            </div>
            <textarea
              className="settings-input skills-textarea"
              value={template}
              spellCheck={false}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </div>
        )}
      </div>
    </Modal>
  );
};
