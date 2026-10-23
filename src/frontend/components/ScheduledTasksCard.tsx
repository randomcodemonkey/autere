import React, { Fragment, useState, useEffect, useCallback } from 'react';
import { DataTable } from './DataTable';
import { Modal } from './Modal';
import { SortableList } from './SortableList';
import { API } from '../api-paths';
import { validateCron, describeCron } from '../../shared/cron';
import type { ScheduledTask, TaskRunRecord, TaskRunLog } from '../types';
import { canRunTaskScripts } from '../../shared/tasks';
import { apiJSON, apiSend } from '../api';

interface TaskModelOption {
  provider: string;
  id: string;
  name?: string;
}

interface ScheduledTasksCardProps {
  sseConnected: boolean;
  userRole: string | null;
  /** Bumped by the scheduler's 'tasks' SSE event (run started/finished) */
  tasksVersion?: number;
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
  saveSession: boolean;
  workdirs: string[]; // first is the cwd; [] = inherit / none
  reuseSession: boolean;
  clearSession: boolean;
  saveLastSession: boolean;
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
  saveSession: false,
  workdirs: [],
  reuseSession: false,
  clearSession: false,
  saveLastSession: false,
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

export const ScheduledTasksCard: React.FC<ScheduledTasksCardProps> = ({ sseConnected, userRole = 'admin', tasksVersion = 0 }) => {
  const canUseScripts = canRunTaskScripts(userRole);
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
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'lastrun' | 'name' | 'created'>('lastrun');

  const refresh = useCallback(async () => {
    try {
      const data = await apiJSON<{ tasks?: ScheduledTask[]; runs?: TaskRunRecord[] }>(API.scheduler.tasks);
      setTasks(data.tasks || []);
      setRuns(data.runs || []);
      const active = new Set<string>(
        (data.runs || []).filter((r) => r.status === 'running').map((r) => r.taskId),
      );
      setRunningTaskIds(active);
    } catch (err) {
      console.error('Failed to load scheduled tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Push-driven: the scheduler emits a 'tasks' event when a run starts or
  // finishes (tasksVersion), and mount / reconnect fetches current state.
  // No interval — an idle card costs nothing.
  useEffect(() => {
    refresh();
  }, [refresh, sseConnected, tasksVersion]);

  // Model options for the per-task model selector
  useEffect(() => {
    apiJSON<any[]>(API.session.models)
      .then((list) => { if (Array.isArray(list)) setModels(list); })
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
      saveSession: task.saveSession === true,
      workdirs: task.workdirs || [],
      reuseSession: task.reuseSession === true,
      clearSession: task.clearSession === true,
      saveLastSession: task.saveLastSession === true,
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
    const workdirs = form.workdirs.filter(Boolean);
    try {
      await apiSend(
        form.id ? API.scheduler.task(form.id) : API.scheduler.tasks,
        form.id ? 'PUT' : 'POST',
        {
          name: form.name,
          schedule: form.schedule,
          prompt: form.prompt,
          model: form.model || undefined,
          ...(canUseScripts ? { seedScript: form.seedScript, resultScript: form.resultScript } : {}),
          enabled: form.enabled,
          saveSession: form.saveSession,
          workdirs,
          reuseSession: form.reuseSession,
          clearSession: form.reuseSession && form.clearSession,
          saveLastSession: form.saveLastSession,
        },
      );
      setForm(null);
      await refresh();
    } catch (err: any) {
      setError(`Failed to save task: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }, [form, refresh, canUseScripts]);

  const handleDelete = useCallback(async (task: ScheduledTask) => {
    if (!confirm(`Delete scheduled task "${task.name}"? Its run logs are removed too.`)) return;
    setError(null);
    try {
      await apiSend(API.scheduler.task(task.id), 'DELETE');
      await refresh();
    } catch (err) {
      setError(`Failed to delete task: ${err}`);
    }
  }, [refresh]);

  const handleRunNow = useCallback(async (task: ScheduledTask) => {
    setError(null);
    setRunningTaskIds(prev => new Set(prev).add(task.id));
    try {
      try {
        await apiSend(API.scheduler.taskRun(task.id), 'POST');
        setExpandedTaskId(task.id);
        refresh();
      } catch (err: any) {
        setError(err.message || 'Failed to run task');
        setRunningTaskIds(prev => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      }
    } catch (err) {
      setError(`Failed to run task: ${err}`);
    }
  }, [refresh]);

  const handleViewLog = useCallback(async (rec: TaskRunRecord) => {
    try {
      setViewLog(await apiJSON(API.scheduler.runLog(rec.taskId, rec.runId)));
    } catch (err) {
      setError(`Failed to load run log: ${err}`);
    }
  }, []);

  const runsFor = useCallback((taskId: string) =>
    runs.filter(r => r.taskId === taskId).slice(0, 10), [runs]);

  const handleCleanupOneOffs = useCallback(async () => {
    if (!confirm('Delete all one-off tasks older than 1 day?')) return;
    setError(null);
    try {
      await apiSend(API.scheduler.purgeOneOff, 'DELETE');
      await refresh();
    } catch (err) {
      setError(`Failed to delete old one-off tasks: ${err}`);
    }
  }, [refresh]);

  const cronErrFor = form ? validateCron(form.schedule.trim()) : null;

  // Most recent run per task — the default sort key (newest first; tasks
  // that never ran sort last, ties fall back to creation order).
  const lastRunAt = new Map<string, number>();
  for (const r of runs) {
    const prev = lastRunAt.get(r.taskId) ?? 0;
    if (r.startedAt > prev) lastRunAt.set(r.taskId, r.startedAt);
  }
  const needle = query.trim().toLowerCase();
  const visibleTasks = tasks
    .filter((t) => !needle || t.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'created') return b.createdAt - a.createdAt;
      return (lastRunAt.get(b.id) ?? 0) - (lastRunAt.get(a.id) ?? 0) || b.createdAt - a.createdAt;
    });

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
            <div className="settings-description">
              Model used for this task's runs. When unset, your pi default model applies.
            </div>
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
          </div>
          {canUseScripts && <>
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
          </>}
          <div className="settings-field">
            <label className="settings-label">Workdirs (optional)</label>
            <SortableList
              items={form.workdirs}
              onChange={(items) => setForm({ ...form, workdirs: items })}
              placeholder="/home/autere/code/… (or relative to $HOME)"
              addLabel="Add workdir"
            />
            <div className="settings-description">
              When set, runs are sandboxed (even if sandboxing is off) with these
              directories mounted. The first path is used as the working directory.
              Empty: runs inherit the creating session's environment.
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">Save task sessions</label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  className="scheduled-input-savesession"
                  checked={form.saveSession}
                  disabled={form.saveLastSession}
                  onChange={(e) => setForm({ ...form, saveSession: e.target.checked })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
            <div className="settings-description">
              Keep a run's session after the run finishes. Off (default): the session is
              deleted for good once the run completes — the run log stays under Runs.
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">Save last task session</label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  className="scheduled-input-savelast"
                  checked={form.saveLastSession}
                  disabled={form.saveSession}
                  onChange={(e) => setForm({ ...form, saveLastSession: e.target.checked })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
            <div className="settings-description">
              Keep only the most recent run's session: when a run starts, older run
              sessions of this task are deleted; the running one is kept until the next
              run replaces it. Not available with Save task sessions.
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">Reuse session</label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  className="scheduled-input-reuse"
                  checked={form.reuseSession}
                  onChange={(e) => setForm({ ...form, reuseSession: e.target.checked, clearSession: e.target.checked ? form.clearSession : false })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
            <div className="settings-description">
              Run on the same session every time instead of a fresh one per run.
            </div>
            {form.reuseSession && (
              <div className="settings-field-header scheduled-clear-row">
                <label className="settings-label">Clear session before each run</label>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    className="scheduled-input-clear"
                    checked={form.clearSession}
                    onChange={(e) => setForm({ ...form, clearSession: e.target.checked })}
                  />
                  <span className="settings-toggle-slider" />
                </label>
              </div>
            )}
            {form.reuseSession && form.clearSession && (
              <div className="settings-description">
                The session id and name stay, but previous context is wiped before every run.
              </div>
            )}
          </div>
          <div className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">Enabled</label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  className="scheduled-input-enabled"
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

      <div className="scheduled-toolbar">
        <input
          className="scheduled-search"
          type="text"
          placeholder="Search tasks by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="scheduled-sort"
          value={sortBy}
          title="Sort tasks"
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
        >
          <option value="lastrun">Sort: last run</option>
          <option value="name">Sort: name</option>
          <option value="created">Sort: created</option>
        </select>
        <button className="btn btn-w-auto scheduled-cleanup-btn" title="Delete all one-off tasks older than 1 day" onClick={handleCleanupOneOffs}>
          Delete old one-offs
        </button>
      </div>

      {/* Hide during the initial load — SSE isn't up yet but the fetch works */}
      {!sseConnected && !loading && <div className="settings-error">Not connected to the backend.</div>}
      {error && <div className="scheduled-error">{error}</div>}

      {loading ? (
        <div className="scheduled-loading">Loading scheduled tasks…</div>
      ) : visibleTasks.length === 0 ? (
        <div className="scheduled-empty">
          {tasks.length === 0
            ? 'No scheduled tasks yet. Create one to run prompts on a schedule.'
            : `No tasks match "${query.trim()}".`}
        </div>
      ) : (
        <DataTable
          className="scheduled-table"
          columns={[
            { key: 'state', label: 'State' },
            { key: 'task', label: 'Task' },
            { key: 'schedule', label: 'Schedule' },
            { key: 'actions', label: '' },
          ]}
        >
          {visibleTasks.map((task) => {
            const isRunning = runningTaskIds.has(task.id);
            const expanded = expandedTaskId === task.id;
            const details = [
              task.model && `Model: ${task.model}`,
              canUseScripts && task.seedScript && `Seed script: ${task.seedScript.slice(0, 80)}`,
              canUseScripts && task.resultScript && `Result script: ${task.resultScript.slice(0, 80)}`,
              task.saveSession && 'Saves task sessions',
              task.saveLastSession && 'Keeps only the last run session',
              task.reuseSession && (task.clearSession ? 'Reuses one session (cleared each run)' : 'Reuses one session'),
              Array.isArray(task.workdirs) && task.workdirs.length > 0 && `Workdirs: ${task.workdirs.join(', ')}`,
            ].filter(Boolean) as string[];
            return (
              <Fragment key={task.id}>
                <tr className={`scheduled-task${expanded ? ' expanded' : ''}`}>
                  <td data-label="State">
                    <span className={`scheduled-enabled-dot ${task.enabled ? 'on' : 'off'}`}
                          title={task.enabled ? 'Enabled' : 'Disabled'} />
                    {!task.enabled && <span className="scheduled-disabled-label">Disabled</span>}
                  </td>
                  <td data-label="Task" className="scheduled-task-cell">
                    <span className="scheduled-task-name">{task.name}</span>
                    {details.length > 0 && (
                      <div className="scheduled-task-detail">
                        {details.map((d, i) => <div key={i}>{d}</div>)}
                      </div>
                    )}
                  </td>
                  <td data-label="Schedule">
                    <span className="scheduled-task-schedule" title={task.once ? undefined : task.schedule}>
                      {task.once
                        ? 'one-off (runs once)'
                        : <>{describeCron(task.schedule)} <span className="scheduled-cron-expr">({task.schedule})</span></>}
                    </span>
                  </td>
                  <td data-label="Actions" className="data-table-actions">
                    <button
                      className="btn btn-row scheduled-run-btn"
                      disabled={isRunning}
                      title={isRunning ? 'Run in progress' : 'Run now'}
                      onClick={() => handleRunNow(task)}
                    >
                      {isRunning ? 'Running…' : 'Run now'}
                    </button>
                    <button
                      className="btn btn-row scheduled-toggle-runs-btn"
                      onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                    >
                      Runs {expanded ? '▾' : '▸'}
                    </button>
                    <button className="btn btn-row scheduled-edit-btn" onClick={() => handleEdit(task)}>Edit</button>
                    <button className="btn btn-danger btn-row scheduled-delete-btn" onClick={() => handleDelete(task)}>Delete</button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="scheduled-runs-tr">
                    <td colSpan={4}>
                      <div className="scheduled-runs">
                        {runsFor(task.id).length === 0 ? (
                          <div className="scheduled-runs-empty">No runs yet.</div>
                        ) : (
                          <DataTable
                            className="scheduled-runs-table"
                            columns={[
                              { key: 'status', label: 'Status' },
                              { key: 'started', label: 'Started' },
                              { key: 'trigger', label: 'Trigger' },
                              { key: 'duration', label: 'Duration' },
                              { key: 'log', label: '' },
                            ]}
                          >
                            {runsFor(task.id).map((rec) => (
                              <tr key={rec.runId} className="scheduled-run-row">
                                <td data-label="Status">
                                  <span className={`sched-run-status sched-run-${rec.status}`}>
                                    {rec.status === 'running' ? '● running' : rec.status}
                                  </span>
                                </td>
                                <td data-label="Started"><span className="sched-run-time">{formatTime(rec.startedAt)}</span></td>
                                <td data-label="Trigger"><span className="sched-run-trigger">{rec.trigger}</span></td>
                                <td data-label="Duration"><span className="sched-run-duration">{formatDuration(rec)}</span></td>
                                <td data-label="Log"><button className="btn btn-row sched-run-log-btn" onClick={() => handleViewLog(rec)}>Log</button></td>
                              </tr>
                            ))}
                          </DataTable>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </DataTable>
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
              {canUseScripts && viewLog.seedOutput !== undefined && (
                <div className="sched-log-section">
                  <div className="sched-log-label">Seed output</div>
                  <pre className="sched-log-pre">{viewLog.seedOutput}</pre>
                </div>
              )}
              {canUseScripts && viewLog.resultScriptOutput !== undefined && (
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
