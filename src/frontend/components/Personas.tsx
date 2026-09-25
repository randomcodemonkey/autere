import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from './Modal';
import { useCardState } from '../hooks/useCardState';
import { url } from '../base-path';
import { API } from '../api-paths';
import type { Persona } from '../types';

/**
 * Shared persona-library store: the Agent card and the Settings section live
 * in different subtrees, so a module-level cache + subscribers keeps the
 * Agent card's select current after a persona is created/deleted in Settings.
 */
let personasCache: Persona[] = [];
const personaSubscribers = new Set<(p: Persona[]) => void>();

function reloadPersonas(): Promise<Persona[]> {
  return fetch(url(API.personas.root))
    .then((r) => r.json())
    .then((d) => {
      if (d.success) {
        personasCache = d.data || [];
        personaSubscribers.forEach((fn) => fn(personasCache));
      }
      return personasCache;
    })
    .catch(() => personasCache);
}

function usePersonas() {
  const [personas, setPersonas] = useState<Persona[]>(personasCache);
  useEffect(() => {
    personaSubscribers.add(setPersonas);
    reloadPersonas(); // refetch on mount — also heals staleness from other tabs
    return () => { personaSubscribers.delete(setPersonas); };
  }, []);
  return { personas, reload: reloadPersonas };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Agent card section: shows the current session's persona and allows
 * changing it for the ACTIVE session. Changing PUTs the session/persona —
 * the backend rebinds and broadcasts status; the extension injects the
 * new persona into the LLM context on the next call.
 */
export const PersonaSection: React.FC<{ persona: { id: string; name: string } | null | undefined }> = ({ persona }) => {
  const { collapsed, toggle } = useCardState('persona');
  const { personas } = usePersonas();
  const [changing, setChanging] = useState(false);

  const change = useCallback(async (id: string) => {
    setChanging(true);
    try {
      await fetch(url(API.session.persona), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ personaId: id || null }) });
    } catch {}
    setChanging(false);
  }, []);

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">Persona</div>
        <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      <div className="persona-agent-body">
        <select
          className="settings-input"
          value={persona?.id || ''}
          disabled={changing}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">No persona</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="settings-description">
          {persona ? `Active: ${persona.name} — injected into this session's context` : 'Active: none'}
        </div>
      </div>
    </div>
  );
};

/**
 * Settings card section: the persona library — list with descriptions,
 * details (prompt) modal, create (with LLM-assisted prompt generation)
 * and delete.
 */
export const PersonasSettingsSection: React.FC = () => {
  const { personas, reload } = usePersonas();
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<Persona | null>(null);
  const [detailsPrompt, setDetailsPrompt] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const openCreate = useCallback(() => {
    setName(''); setDescription(''); setPrompt(''); setError(null);
    setCreating(true);
  }, []);

  const openDetails = useCallback((p: Persona) => {
    setDetails(p);
    setDetailsPrompt(p.prompt);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!name.trim() || !prompt.trim()) { setError('Name and prompt are required'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url(API.personas.root), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name, description, prompt }) });
      const data = await res.json();
      if (data.success) {
        setCreating(false);
        reload();
      } else {
        setError(data.error || 'Failed to save persona');
      }
    } catch {
      setError('Failed to save persona');
    } finally {
      setSaving(false);
    }
  }, [name, description, prompt, reload]);

  const remove = useCallback(async (id: string) => {
    if (!window.confirm('Delete this persona?')) return;
    try {
      await fetch(url(API.personas.item(id)), { method: 'DELETE', headers: JSON_HEADERS });
      reload();
    } catch {}
  }, [reload]);

  /** Shared by create + details modals (never open at the same time) */
  const runGenerate = useCallback(async (text: string, onResult: (prompt: string) => void) => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(url(API.personas.generate), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (data.success && data.data?.prompt) onResult(data.data.prompt);
      else setError(data.error || 'Failed to generate prompt');
    } catch {
      setError('Failed to generate prompt');
    } finally {
      setGenerating(false);
    }
  }, []);

  const generate = useCallback(() => runGenerate(prompt, setPrompt), [runGenerate, prompt]);

  const regenerateDetails = useCallback(() => runGenerate(detailsPrompt, setDetailsPrompt), [runGenerate, detailsPrompt]);

  const saveDetails = useCallback(async () => {
    if (!details) return;
    if (!detailsPrompt.trim()) { setError('Prompt is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url(details.id ? API.personas.item(details.id) : API.personas.root), {
        method: details.id ? 'PUT' : 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: details.name, description: details.description, prompt: detailsPrompt }),
      });
      const data = await res.json();
      if (data.success) {
        setDetails(null);
        reload();
      } else {
        setError(data.error || 'Failed to save persona');
      }
    } catch {
      setError('Failed to save persona');
    } finally {
      setSaving(false);
    }
  }, [details, detailsPrompt, reload]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Personas</h3>
      <button className="btn btn-default persona-new-btn" onClick={openCreate}>+ New Persona</button>
      {personas.length === 0 ? (
        <div className="settings-description">No personas yet — create one to give your agent a standing role and select it when creating a session.</div>
      ) : (
        <div className="persona-list">
          {personas.map((p) => (
            <div key={p.id} className="persona-item">
              <div className="persona-item-main">
                <span className="persona-name">{p.name}</span>
                {p.description && <span className="persona-description">{p.description}</span>}
              </div>
              <button className="btn btn-default persona-item-btn" onClick={() => openDetails(p)}>Details</button>
              <button className="btn btn-danger persona-item-btn" onClick={() => remove(p.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      {/* Conditionally rendered: Modal always renders its div even when
          closed, and component tests load no global CSS — a mounted-but-closed
          modal would leak its buttons/fields into selectors. */}
      {creating && (
        <Modal open onClose={() => setCreating(false)} className="modal-persona">
        <div className="modal-header">
          <h3>New Persona</h3>
          <button className="modal-close" onClick={() => setCreating(false)}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="settings-error">{error}</div>}
          <div className="settings-field">
            <label className="settings-label">Name</label>
            <input className="settings-input" value={name} maxLength={80} placeholder="e.g. Code Reviewer" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Short description</label>
            <input className="settings-input" value={description} maxLength={200} placeholder="Shown in the persona list" onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Prompt</label>
            <textarea
              className="settings-input"
              rows={8}
              value={prompt}
              placeholder="Describe the persona — its role, tone and behavior…"
              spellCheck={false}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {prompt.trim().length > 0 && (
              <div className="persona-generate-row">
                <button className="btn btn-default" onClick={generate} disabled={generating}>
                  {generating ? '⏳ Generating…' : '✨ Generate prompt'}
                </button>
                <span className="settings-description">Uses the given text and generates a prompt from it with the current session's model.</span>
              </div>
            )}
          </div>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Create Persona'}</button>
            <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      </Modal>
      )}

      {details && (
      <Modal open onClose={() => setDetails(null)} className="modal-persona">
        <div className="modal-header">
          <h3>{details?.name}</h3>
          <button className="modal-close" onClick={() => setDetails(null)}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="settings-error">{error}</div>}
          {details?.description && <div className="persona-description persona-details-description">{details.description}</div>}
          <textarea
            className="settings-input persona-details-prompt"
            rows={8}
            value={detailsPrompt}
            placeholder="Persona prompt…"
            spellCheck={false}
            onChange={(e) => setDetailsPrompt(e.target.value)}
          />
          {detailsPrompt.trim().length > 0 && (
            <div className="persona-generate-row">
              <button className="btn btn-default" onClick={regenerateDetails} disabled={generating}>
                {generating ? '⏳ Generating…' : '✨ Regenerate prompt'}
              </button>
              <span className="settings-description">Uses the current text and generates a prompt from it with the current session's model.</span>
            </div>
          )}
          <div className="btn-group">
            <button
              className="btn btn-primary"
              onClick={saveDetails}
              disabled={saving || detailsPrompt.trim() === details?.prompt}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>
      )}
    </div>
  );
};
