import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';
import { API } from '../api-paths';
import { validateCron, describeCron } from '../../shared/cron';
import type { ScheduledTask, TaskRunRecord, TaskRunLog } from '../types';

interface TaskModelOption {
  provider: string;
  id: string;
  name?: string;
}

interface ScheduledTasksCardProps {
  sseConnected: boolean;
}

interface TaskFormState {
  id: string | null; // null = creating
  name: string;
  schedule: string;
  prompt: string;
  seedScript: string;
  resultScript: string;
  enabled: boolean;
  model: string; // '' = user's pi default
}

const EMPTY_FORM: TaskFormState = {
  id: null,
  name: '',
  schedule: '*/15 * * * *',
  prompt: '',
  seedScript: '',
  resultScript: '',
  enabled: true,
  model: '',
};

function formatTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function formatDuration(rec: TaskRunRecord): string {
  if (!rec.finishedAt) return '';
  const s = Math.max(0, Math.round((rec.finishedAt - rec.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const ScheduledTasksCard: React.FC<ScheduledTasksCardProps> = ({ sseConnected }) => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<TaskRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<TaskFormState | null>(null); // null = list view
  const [saving, setSaving] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [viewLog, setViewLog] = useState<TaskRunLog | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<TaskModelOption[]>([]);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(url(API.scheduler.tasks));
      const data = await res.json();
      if (data.success) {
        setTasks(data.data.tasks || []);
        setRuns(data.data.runs || []);
        const active = new Set<string>(
          (data.data.runs || [])
            .filter((r: TaskRunRecord) => r.status === 'running')
            .map((r: TaskRunRecord) => r.taskId),
        );
        setRunningTaskIds(active);
      }
    } catch (err) {
      console.error('Failed to load scheduled tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    pollTimer.current = setInterval(refresh, 3000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [refresh]);

  // Model options for the per-task model selector
  useEffect(() => {
    fetch(url(API.session.models))
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.data)) setModels(data.data);
      })
      .catch(() => {});
  }, [sseConnected]);

  const handleNew = useCallback(() => {
    setError(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const handleEdit = useCallback((task: ScheduledTask) => {
    setError(null);
    setForm({
      id: task.id,
      name: task.name,
      schedule: task.schedule,
      prompt: task.prompt,
      seedScript: task.seedScript || '',
      resultScript: task.resultScript || '',
      enabled: task.enabled,
      model: task.model || '',
    });
  }, []);

  const handleCancelForm = useCallback(() => {
    setForm(null);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form) return;
    const cronErr = validateCron(form.schedule.trim());
    if (cronErr) {
      setError(`Invalid schedule: ${cronErr}`);
      return;
    }
    if (!form.name.trim() || !form.prompt.trim()) {
      setError('Name and prompt are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const endpoint = form.id
        ? url(API.scheduler.task(form.id))
        : url(API.scheduler.tasks);
      const res = await fetch(endpoint, {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          schedule: form.schedule,
          prompt: form.prompt,
          model: form.model || undefined,
          seedScript: form.seedScript,
          resultScript: form.resultScript,
          enabled: form.enabled,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setForm(null);
        await refresh();
      } else {
        setError(data.error || 'Failed to save task');
      }
    } catch (err) {
      setError(`Failed to save task: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [form, refresh]);

  const handleDelete = useCallback(async (task: ScheduledTask) => {
    if (!confirm(`Delete scheduled task "${task.name}"? Its run logs are removed too.`)) return;
    setError(null);
    try {
      const res = await fetch(url(API.scheduler.task(task.id)), { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to delete task');
      await refresh();
    } catch (err) {
      setError(`Failed to delete task: ${err}`);
    }
  }, [refresh]);

  const handleRunNow = useCallback(async (task: ScheduledTask) => {
    setError(null);
    setRunningTaskIds(prev => new Set(prev).add(task.id));
    try {
      const res = await fetch(url(API.scheduler.taskRun(task.id)), { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to run task');
        setRunningTaskIds(prev => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      } else {
        setExpandedTaskId(task.id);
        refresh();
      }
    } catch (err) {
      setError(`Failed to run task: ${err}`);
    }
  }, [refresh]);

  const handleViewLog = useCallback(async (rec: TaskRunRecord) => {
    try {
      const res = await fetch(url(API.scheduler.runLog(rec.taskId, rec.runId)));
      const data = await res.json();
      if (data.success) setViewLog(data.data);
      else setError(data.error || 'Failed to load run log');
    } catch (err) {
      setError(`Failed to load run log: ${err}`);
    }
  }, []);

  const runsFor = useCallback((taskId: string) =>
    runs.filter(r => r.taskId === taskId).slice(0, 10), [runs]);

  const cronErrFor = form ? validateCron(form.schedule.trim()) : null;

  // ── Form view ──

  if (form) {
    return (
      <div className="card scheduled-card">
        <div className="card-header">
          <span className="card-title">{form.id ? 'Edit Scheduled Task' : 'New Scheduled Task'}</span>
        </div>
        {error && <div className="scheduled-error">{error}</div>}
        <div className="scheduled-form">
          <div className="settings-field">
            <label className="settings-label">Name</label>
            <input
              className="settings-input scheduled-input-name"
              value={form.name}
              placeholder="e.g. Daily report"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Schedule (cron)</label>
            <input
              className="settings-input scheduled-input-schedule"
              value={form.schedule}
              placeholder="*/15 * * * *"
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            />
            {cronErrFor
              ? <div className="settings-description scheduled-cron-error">Invalid: {cronErrFor}</div>
              : <div className="settings-description">{describeCron(form.schedule.trim())}</div>}
          </div>
          <div className="settings-field">
            <label className="settings-label">Prompt</label>
            <textarea
              className="settings-input scheduled-input-prompt"
              rows={4}
              value={form.prompt}
              placeholder="Prompt sent to the pi agent on every run"
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Model</label>
            <select
              className="settings-input scheduled-input-model"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            >
              <option value="">Default (user's pi setting)</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id} ({m.provider})
                </option>
              ))}
            </select>
            <div className="settings-description">
              Model used for this task's runs. When unset, your pi default model applies.
            </div>
          </div>
          <div className="settings-field">
            <label className="settings-label">Seed script (optional)</label>
            <textarea
              className="settings-input scheduled-input-seed"
              rows={3}
              value={form.seedScript}
              placeholder={'Shell script — stdout is appended to the prompt\ne.g. cat ~/notes/today.md'}
              onChange={(e) => setForm({ ...form, seedScript: e.target.value })}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Result script (optional)</label>
            <textarea
              className="settings-input scheduled-input-result"
              rows={3}
              value={form.resultScript}
              placeholder={'Shell script — receives the agent result on stdin\ne.g. tee ~/reports/last-result.txt'}
              onChange={(e) => setForm({ ...form, resultScript: e.target.value })}
            />
          </div>
          <div className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">Enabled</label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
          </div>
          <div className="scheduled-form-actions">
            <button className="btn btn-primary scheduled-save-btn" onClick={handleSave} disabled={saving || !!cronErrFor}>
              {saving ? 'Saving…' : 'Save Task'}
            </button>
            <button className="btn scheduled-cancel-btn" onClick={handleCancelForm} disabled={saving}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view ──

  return (
    <div className="card scheduled-card">
      <div className="card-header">
        <span className="card-title">Scheduled Tasks</span>
        <button className="btn btn-primary scheduled-new-btn" onClick={handleNew}>New Task</button>
      </div>

      {!sseConnected && <div className="settings-error">Not connected to the backend.</div>}
      {error && <div className="scheduled-error">{error}</div>}

      {loading ? (
        <div className="scheduled-loading">Loading scheduled tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="scheduled-empty">
          No scheduled tasks yet. Create one to run prompts on a schedule.
        </div>
      ) : (
        <div className="scheduled-list">
          {tasks.map((task) => {
            const isRunning = runningTaskIds.has(task.id);
            const expanded = expandedTaskId === task.id;
            return (
              <div key={task.id} className={`scheduled-task${expanded ? ' expanded' : ''}`}>
                <div className="scheduled-task-row">
                  <span className={`scheduled-enabled-dot ${task.enabled ? 'on' : 'off'}`}
                        title={task.enabled ? 'Enabled' : 'Disabled'} />
                  <div className="scheduled-task-main">
                    <div className="scheduled-task-name">{task.name}</div>
                    <div className="scheduled-task-schedule" title={task.schedule}>
                      {describeCron(task.schedule)} <span className="scheduled-cron-expr">({task.schedule})</span>
                    </div>
                  </div>
                  <div className="scheduled-task-actions">
                    <button
                      className="btn scheduled-run-btn"
                      disabled={isRunning}
                      title={isRunning ? 'Run in progress' : 'Run now'}
                      onClick={() => handleRunNow(task)}
                    >
                      {isRunning ? 'Running…' : 'Run now'}
                    </button>
                    <button
                      className="btn scheduled-toggle-runs-btn"
                      onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                    >
                      Runs {expanded ? '▾' : '▸'}
                    </button>
                    <button className="btn scheduled-edit-btn" onClick={() => handleEdit(task)}>Edit</button>
                    <button className="btn btn-danger scheduled-delete-btn" onClick={() => handleDelete(task)}>Delete</button>
                  </div>
                </div>
                {task.model && <div className="scheduled-task-detail">Model: {task.model}</div>}
                {task.seedScript && <div className="scheduled-task-detail">Seed script: {task.seedScript.slice(0, 80)}</div>}
                {task.resultScript && <div className="scheduled-task-detail">Result script: {task.resultScript.slice(0, 80)}</div>}
                {expanded && (
                  <div className="scheduled-runs">
                    {runsFor(task.id).length === 0 ? (
                      <div className="scheduled-runs-empty">No runs yet.</div>
                    ) : runsFor(task.id).map((rec) => (
                      <div key={rec.runId} className="scheduled-run-row">
                        <span className={`sched-run-status sched-run-${rec.status}`}>
                          {rec.status === 'running' ? '● running' : rec.status}
                        </span>
                        <span className="sched-run-time">{formatTime(rec.startedAt)}</span>
                        <span className="sched-run-trigger">{rec.trigger}</span>
                        <span className="sched-run-duration">{formatDuration(rec)}</span>
                        <button className="btn sched-run-log-btn" onClick={() => handleViewLog(rec)}>Log</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={!!viewLog} onClose={() => setViewLog(null)} className="modal-status modal-sched-log">
        {viewLog && (
          <>
            <div className="modal-header">
              <h3>Run log — {viewLog.taskName}</h3>
              <button className="modal-close" onClick={() => setViewLog(null)}>✕</button>
            </div>
            <div className="modal-body sched-log-body">
              <div className="sched-log-meta">
                <span className={`sched-run-status sched-run-${viewLog.status}`}>{viewLog.status}</span>
                <span>{formatTime(viewLog.startedAt)}{viewLog.finishedAt ? ` → ${formatTime(viewLog.finishedAt)}` : ''}</span>
                {viewLog.error && <span className="sched-log-error">Error: {viewLog.error}</span>}
              </div>
              {viewLog.prompt && (
                <div className="sched-log-section">
                  <div className="sched-log-label">Prompt</div>
                  <pre className="sched-log-pre">{viewLog.prompt}</pre>
                </div>
              )}
              {viewLog.agentResult !== undefined && (
                <div className="sched-log-section">
                  <div className="sched-log-label">Agent result</div>
                  <pre className="sched-log-pre">{viewLog.agentResult}</pre>
                </div>
              )}
              {viewLog.resultScriptOutput !== undefined && (
                <div className="sched-log-section">
                  <div className="sched-log-label">Result script output</div>
                  <pre className="sched-log-pre">{viewLog.resultScriptOutput}</pre>
                </div>
              )}
              <div className="sched-log-section">
                <div className="sched-log-label">Log</div>
                <pre className="sched-log-pre sched-log-lines">
                  {viewLog.log.map((entry) => `${formatTime(entry.t)}  ${entry.line}`).join('\n')}
                </pre>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};
