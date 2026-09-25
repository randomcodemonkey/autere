import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header, ViewId } from '../components/Header';
import { StatusCard } from '../components/StatusCard';
import { SettingsCard } from '../components/SettingsCard';
import { ScheduledTasksCard } from '../components/ScheduledTasksCard';
import { EditsPage } from '../components/EditsPage';
import { UsersCard } from '../components/UsersCard';
import { StreamCard } from '../components/StreamCard';
import { Modal } from '../components/Modal';
import { SessionView } from '../components/SessionModal';
import { url, basePath } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';
import type {
  SessionState,
  SessionStats,
  StreamMessage,
  ActiveTool,
  RecentTool,
  ExtensionInfo,
  AvailableModel,
  SessionInfo,
  SSEMessage,
} from '../types';

const EMPTY_STATS: SessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  contextUsage: null,
};

/** Combine base auth/SSE status with session streaming state */
function computeStatus(baseType: string, baseText: string, s: SessionState): { type: string; text: string } {
  if (baseType === 'disconnected') return { type: 'disconnected', text: 'Disconnected' };
  if (baseType === 'loading') return { type: 'loading', text: 'Loading…' };
  if (s.compacting) return { type: 'streaming', text: 'Compacting' };
  if (s.isStreaming) return { type: 'streaming', text: 'Working' };
  return { type: 'connected', text: baseText === 'Disconnected' ? 'Disconnected' : 'Idle' };
}

interface DashboardPageProps {
  authenticated: boolean;
  username: string | null;
  userRole: string | null;
  logout: () => Promise<void>;
  sseConnected: boolean;
  pageHandlerRef: React.MutableRefObject<(msg: SSEMessage) => void>;
  baseStatusType: string;
  baseStatusText: string;
  restarting: boolean;
  setRestarting: (v: boolean) => void;
  sseDisconnect: () => void;
  sseConnect: () => void;
}

export function DashboardPage({
  authenticated,
  username,
  userRole,
  logout,
  sseConnected,
  pageHandlerRef,
  baseStatusType,
  baseStatusText,
  restarting,
  setRestarting,
  sseDisconnect,
  sseConnect,
}: DashboardPageProps) {
  const { sessionId: urlSessionId, view } = useParams<{ sessionId?: string; view?: string }>();
  const navigate = useNavigate();

  // View switching (chat / status / settings). On desktop the status card is
  // always visible on the left and the selection swaps the right pane; on
  // mobile each view is a full-screen card (CSS).
  const activeView: ViewId = view === 'settings' ? 'settings' : view === 'status' ? 'status' : view === 'sessions' ? 'sessions' : view === 'tasks' ? 'tasks' : view === 'edits' ? 'edits' : view === 'users' && userRole === 'admin' ? 'users' : 'chat';
  const handleSetView = useCallback((v: ViewId) => {
    if (!urlSessionId) return;
    navigate(v === 'chat' ? `/session/${urlSessionId}` : `/session/${urlSessionId}/${v}`);
  }, [navigate, urlSessionId]);

  // Session state
  const [sessionState, setSessionState] = useState<SessionState>({
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    messageCount: 0,
    requestCount: 0,
    pendingMessageCount: 0,
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    connected: false,
    startTime: Date.now(),
    compacting: false,
  });

  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);

  const [streamHistory, setStreamHistory] = useState<StreamMessage[]>([]);
  // Optimistic user messages: shown immediately after a successful send,
  // removed once the backend broadcast carries the same text.
  const [pendingUser, setPendingUser] = useState<StreamMessage[]>([]);
  const [, setActiveTools] = useState<ActiveTool[]>([]);
  const [, setRecentTools] = useState<RecentTool[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);

  // Header quick-switch tabs need fresh active/streaming flags; 'sessions'
  // SSE broadcasts only fire on some actions, so poll the session list.
  useEffect(() => {
    if (!authenticated) return;
    let timer: number | undefined;
    const poll = () => {
      fetch(url(API.sessions.list)).then(r => r.json()).then(d => {
        if (d.success) setAvailableSessions(d.data);
      }).catch(() => {});
      timer = window.setTimeout(poll, 5000);
    };
    poll();
    return () => clearTimeout(timer);
  }, [authenticated]);
  // Correctness guard for backend-death staleness: when the SSE base status
  // settles on 'disconnected' (backend killed, restart pending), no one can
  // ever deliver agent_end/compaction_end anymore — so the last-known
  // isStreaming/compacting flags would show a phantom blue 'Compacting' chip
  // forever. Clear them; nothing can be in progress without a backend.
  const prevBaseStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (baseStatusType === 'disconnected' && prevBaseStatusRef.current !== 'disconnected') {
      setSessionState((prev: any) => (prev.isStreaming || prev.compacting) ? { ...prev, isStreaming: false, compacting: false } : prev);
    }
    prevBaseStatusRef.current = baseStatusType;
  }, [baseStatusType]);
  // UI state
  const [restartingBackend, setRestartingBackend] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // True while a session switch request is in flight — shown as a banner
  const [switchingSession, setSwitchingSession] = useState(false);
  // Label distinguishes a user-initiated switch ("Switching session…") from
  // a load-time restore via URL / reload ("Loading session…").
  const [switchLabel, setSwitchLabel] = useState('Switching session…');

  // SSE message handler
  // Guards fetch responses and status events against session changes: a
  // response/snapshot for a previous session that resolves after a
  // navigation must NOT affect the newly viewed session's state.
  const viewedSessionRef = useRef<string | null>(null);
  viewedSessionRef.current = urlSessionId || null;

  // stream_delta throttling: latest delta text + scheduled flush timer.
  // flushPendingDelta applies the buffered text to streamHistory; if a new
  // streaming entry must be created (first delta of an entry), it does the
  // same append the old unthrottled path did.
  const STREAM_DELTA_FLUSH_MS = 10;
  const pendingDeltaRef = useRef<{ role: 'assistant' | 'thinking'; text: string } | null>(null);
  const deltaFlushTimerRef = useRef<number | null>(null);
  // Clear per-session UI state (used when entering a fresh session)
  const resetSessionUI = useCallback(() => {
    pendingDeltaRef.current = null; // drop stale delta from the previous session
    setStreamHistory([]);
    setPendingUser([]);
    setStats(EMPTY_STATS);
    setActiveTools([]);
    setRecentTools([]);
  }, []);

  const flushPendingDelta = useCallback(() => {
    deltaFlushTimerRef.current = null;
    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = null;
    if (!delta) return;
    setStreamHistory((prev) => {
      // The backend streams at most ONE entry per role — but its upserts
      // (tool results, moved follow-ups, file entries) can land between our
      // deltas, so the streaming entry may not be LAST. Scan for it; only
      // append a synthetic entry when none exists (a blind append here is
      // how duplicate/frozen thinking ghosts were born).
      for (let k = prev.length - 1; k >= 0; k--) {
        if (prev[k].role === delta.role && prev[k].streaming) {
          const next = prev.slice();
          next[k] = { ...prev[k], text: delta.text };
          return next;
        }
      }
      // No streaming entry of this role found: drop the delta. The backend
      // always upserts the entry (with stable id) before deltas flow, and a
      // turn-end snapshot heals any gap — synthesizing entries here is how
      // duplicate/frozen thinking ghosts were born.
      return prev;
    });
  }, []);
  // Clear any scheduled flush on unmount
  useEffect(() => () => {
    if (deltaFlushTimerRef.current !== null) clearTimeout(deltaFlushTimerRef.current);
    deltaFlushTimerRef.current = null;
  }, []);
  // Canonical session id (pi's id may drift from the URL's file-derived id)
  const canonicalSessionIdRef = useRef<string | null>(null);
  canonicalSessionIdRef.current = sessionState.sessionId;
  // The session the user is viewing — stamped on every session-scoped API
  // call so routing never depends on the (racy) server-side binding.
  const targetSessionRef = useRef<string | null>(null);
  targetSessionRef.current = viewedSessionRef.current;

  const handleDashboardSSEMessage = useCallback((msg: SSEMessage) => {
    switch (msg.type) {
      case 'status': {
        const incoming = msg.data;
        const viewed = viewedSessionRef.current;
        // Ignore status snapshots from a DIFFERENT session than the one being
        // viewed (e.g. a late broadcast from the previous session after
        // creating a new session) — applying them would revert
        // sessionState.sessionId and trigger a redundant switch-by-id that
        // aborts an in-flight prompt.
        if (viewed && incoming?.sessionId && incoming.sessionId !== viewed) {
          break;
        }
        // Null sessionId (mid-switch snapshot) must not clear the viewed id
        setSessionState((prev: any) => ({ ...prev, ...incoming, sessionId: incoming?.sessionId ?? prev.sessionId }));
        break;
      }
      case 'error':
        setCreatingSession(false);
        setSessionError(msg.data?.message || 'An error occurred');
        break;
      case 'navigate':
        if (msg.data?.url) {
          setCreatingSession(false);
          resetSessionUI();
          navigate(msg.data.url, { replace: true });
        }
        break;
      case 'stats':
        setStats(msg.data);
        break;
      case 'stream_history': {
        // Ignore history from a session other than the one being viewed
        // (defense against cross-session bleed during switch races).
        const viewed = viewedSessionRef.current;
        // A full-history snapshot supersedes any pending delta — drop it so
        // a late flush can't re-append already-finalized text.
        pendingDeltaRef.current = null;
        if (msg.sessionId && viewed && msg.sessionId !== viewed) break;
        // Ignore EMPTY snapshots that carry no session id — that shape only
        // comes from the SSE connect-time initializer. Applying it would
        // clear already-rendered chat content (the load-time blink).
        if (!msg.sessionId && (!msg.data || msg.data.length === 0)) break;
        // Skip no-op updates: the connect-time replay may deliver exactly
        // what is already rendered — re-applying identical content rebuilds
        // the DOM for nothing.
        const incoming = msg.data || [];
        // Retire optimistic copies whose text now exists in the real history
        // prefix match: queued messages get attachment notes appended server-side, so the committed text is pending text + note
setPendingUser((prev) => prev.length === 0 ? prev : prev.filter((p) => !(incoming as StreamMessage[]).some((m) => m.role === 'user' && (m.text === p.text || m.text.startsWith(p.text)))));
        // Skip no-op updates: the connect-time replay may deliver exactly
        // what is already rendered — re-applying identical content rebuilds
        // the DOM for nothing. Compare via a cheap signature (lengths only)
        // — JSON.stringify here previously copied multi-MB buffers twice
        // on every history event and janked the main thread.
        const sig = (list: StreamMessage[]) => `${list.length}:${list.map((m) => (m.text || '').length).join(',')}`;
        if (sig(streamHistoryRef.current) === sig(incoming)) break;
        setStreamHistory(incoming);
        break;
      }
      case 'history_upsert': {
        // Targeted live mutation: replace-by-stable-id or append. Full
        // stream_history snapshots now only arrive on reconnect/reload/
        // session switch — live turns use this lightweight event.
        const viewed = viewedSessionRef.current;
        if (msg.sessionId && viewed && msg.sessionId !== viewed) break;
        const incoming = (msg.data || []) as StreamMessage[];
        if (incoming.length === 0) break;
        // Upserts are authoritative for the text they carry — drop any
        // buffered delta so a late flush can't clobber finalized text.
        pendingDeltaRef.current = null;
        setStreamHistory((prev) => {
          const next = [...prev];
          let changed = false;
          for (const e of incoming) {
            if (!e) continue;
            // Match priority: stable id → originating tool call → same-role
            // streaming entry (finalize) → identical text. The fallbacks
            // cover entries received before ids existed (bootstrap reads)
            // and role-changing replacements (toolCall → toolResult).
            let i = e.id ? next.findIndex((m) => m.id === e.id) : -1;
            if (i < 0 && e.toolCallId) i = next.findIndex((m) => m.toolCallId === e.toolCallId);
            if (i < 0 && e.role !== 'user') {
              // Never text-match user entries: two identical user messages
              // are legitimate — they must append, not replace.
              // Text-match requires non-empty text: empty-text entries
              // (image/file pseudo-entries) would otherwise replace each
              // other — each new image must append, not overwrite the last.
              for (let k = next.length - 1; k >= 0; k--) {
                const m = next[k];
                if (m.role === e.role && (m.streaming || (!!e.text && (m.text || '') === e.text))) { i = k; break; }
              }
            }
            if (i >= 0) next[i] = e;
            else next.push(e);
            // Invariant: at most one active stream per role. An authoritative
            // finalized entry retires any OTHER streaming entries of the same
            // role (ghosts from race windows would otherwise blink forever).
            if (!e.streaming && (e.role === 'thinking' || e.role === 'assistant')) {
              for (let k = next.length - 1; k >= 0; k--) {
                if (k !== i && next[k].role === e.role && next[k].streaming) next[k].streaming = false;
              }
            }
            changed = true;
          }
          return changed ? next : prev;
        });
        // A committed user entry retires its optimistic pending copy
        setPendingUser((prev) => prev.length === 0 ? prev : prev.filter((p) => !incoming.some((m) => m.role === 'user' && !m.streaming && (m.text === p.text || m.text.startsWith(p.text)))));
        break;
      }
      case 'history_remove': {
        const viewed = viewedSessionRef.current;
        if (msg.sessionId && viewed && msg.sessionId !== viewed) break;
        // Items may be plain ids (legacy) or {id, role, text} objects — the
        // text form lets the client also drop snapshot copies that were
        // rendered under a different id namespace (disk 'd…' ids from before
        // a backend restart, or a prior process's e-seq).
        const items = (msg.data || []) as any[];
        const ids = new Set(items.map((it) => typeof it === 'string' ? it : it?.id).filter(Boolean));
        const texts = items.map((it) => typeof it === 'object' ? it?.text : undefined).filter(Boolean) as string[];
        if (ids.size === 0 && texts.length === 0) break;
        setStreamHistory((prev) => prev.filter((m) => {
          if (m.id && ids.has(m.id)) return false;
          // Text fallback only for user entries: identical user texts are
          // otherwise legitimate, but a move/remove of a queued user message
          // must also catch its snapshot twin. Never match streaming entries.
          if (texts.length > 0 && m.role === 'user' && !m.streaming && texts.some((t) => m.text === t || m.text.startsWith(t))) return false;
          return true;
        }));
        break;
      }
      case 'stream_delta': {
        // Lightweight per-token update: carries only the streaming entry's
        // role and current text — never the full history buffer (which may
        // contain multi-MB base64 images).
        //
        // THROTTLED: deltas can arrive dozens of times per second, and each
        // unthrottled setState re-renders (and re-parses markdown for) the
        // growing streaming message, which janks the main thread and makes
        // typing in ChatInput stutter. Buffer the latest text in a ref and
        // flush to state at most every STREAM_DELTA_FLUSH_MS.
        const viewed = viewedSessionRef.current;
        if (msg.sessionId && viewed && msg.sessionId !== viewed) break;
        const role = msg.data?.role;
        const text = msg.data?.text ?? '';
        if (role !== 'assistant' && role !== 'thinking') break;
        pendingDeltaRef.current = { role, text };
        if (deltaFlushTimerRef.current === null) {
          deltaFlushTimerRef.current = window.setTimeout(flushPendingDelta, STREAM_DELTA_FLUSH_MS);
        }
        break;
      }
      case 'models':
        setModels(msg.data || []);
        break;
      case 'sessions':
        setAvailableSessions(msg.data || []);
        break;
      case 'tool_start':
        setActiveTools((prev) => {
          const tool = msg.data;
          return [...prev, { id: tool.id, name: tool.name, cmd: tool.cmd, args: {}, startTime: Date.now() }];
        });
        break;
      case 'tool_end':
        setActiveTools((prev) => prev.filter((t) => t.id !== msg.data.id));
        if (msg.data.recentTools) setRecentTools(msg.data.recentTools);
        break;
      case 'extensions':
        setExtensions(msg.data || []);
        break;
    }
  }, [navigate, flushPendingDelta, resetSessionUI]);

  // Register our handler with the parent's useSSE via the ref.
  // Set synchronously during render so no messages are missed.
  pageHandlerRef.current = handleDashboardSSEMessage;

  // Apply a bootstrap payload (from GET /api/bootstrap or the switch-by-id
  // response — same shape) to the UI state.
  const applyBootstrap = useCallback((d: any) => {
    setSessionState((prev: any) => ({ ...prev, ...d.sessionState, sessionId: d.sessionState?.sessionId ?? prev.sessionId }));
    // null stats (idle/disk payload) must clear stale numbers from the
    // previously viewed session, not keep them on screen.
    setStats(d.sessionStats ?? EMPTY_STATS);
    setActiveTools(d.activeTools ?? []);
    setRecentTools(d.recentTools ?? []);
    // Optimistic pending copies belong to the OUTGOING session — drop them
    // whenever a bootstrap applies, regardless of history ownership. Leaving
    // them tied to the history-ownership guard made A's un-retired optimistic
    // copies (mid-turn sends) render inside every other session visited.
    setPendingUser([]);
    // Apply history only if it belongs to the session being viewed
    const viewed = viewedSessionRef.current;
    if (!viewed || !d.historySessionId || d.historySessionId === viewed) {
      setStreamHistory(d.streamHistory ?? []);
    }
    setAvailableSessions(d.availableSessions ?? []);
    setModels(d.availableModels ?? []);
    setExtensions(d.extensions ?? []);
  }, []);

  // ── Bootstrap: ONE request loads everything at (re)load time ──
  // Runs on mount and on every SSE (re)connect (a reconnect is a reload:
  // the stream may have missed events while it was down). Navigation
  // between sessions is handled separately by switch-by-id. The SSE stream
  // carries LIVE events only — no history replays or state snapshots.
  const prevConnectedRef = useRef<boolean | null>(null);

  // Epoch-guarded bootstrap fetch — a later call supersedes an in-flight one
  // (e.g. quick visibility flickers or reconnect storms).
  const bootstrapEpochRef = useRef(0);
  const refetchBootstrap = useCallback(() => {
    const epoch = ++bootstrapEpochRef.current;
    const sid = viewedSessionRef.current;
    fetch(url(`${API.bootstrap}${sid ? `?sessionId=${encodeURIComponent(sid)}` : ''}`))
      .then((res) => res.json())
      .then((data) => {
        if (epoch !== bootstrapEpochRef.current || !data.success || !data.data) return;
        const d = data.data;
        // Invalid snapshot: the backend hasn't loaded a session yet (race
        // after an idle respawn) — applying it would zero the UI and strand
        // pending messages. Don't apply; force a switch-by-id instead, whose
        // response is the same payload shape with state recomputed from the
        // session file. No loop: one recovery attempt per bootstrap.
        if (!d.sessionState?.sessionId && sid) {
          fetch(url(API.sessions.activate(sid)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid }),
          })
            .then((r) => r.json())
            .then((r) => {
              if (r.success && r.data && epoch === bootstrapEpochRef.current) {
                applyBootstrap(r.data);
              }
            })
            .catch(() => {});
          return;
        }
        applyBootstrap(data.data);
        // A successful bootstrap means the backend is up — clear restart flags.
        // Unconditional: the callback is stable, so closures would go stale.
        setRestarting(false);
        setRestartingBackend(false);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const isFirstLoad = prevConnectedRef.current === null;
    const isReconnect = prevConnectedRef.current === false && sseConnected === true;
    prevConnectedRef.current = sseConnected;
    if (!isFirstLoad && !isReconnect) return;
    refetchBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, sseConnected]);

  // PWA resume: after a long stretch in the background, JS was frozen and
  // the SSE stream may have gone stale without the browser noticing (no
  // error, no reconnect). A service worker can't run while frozen, so the
  // visibilitychange event on resume is the hook: re-bootstrap to re-sync
  // stats/history/model/session with the backend.
  const lastHiddenAtRef = useRef(0);
  useEffect(() => {
    if (!authenticated) return;
    let lastResume = 0;
    const onResume = (e?: Event) => {
      // iOS standalone PWAs sometimes skip visibilitychange on snapshot
      // resume — pageshow/focus are the reliable signals there. All three
      // fire together on a normal resume; dedupe to run once per wake.
      const now = Date.now();
      if (now - lastResume < 2000) return;
      lastResume = now;
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = now;
        return;
      }
      // A persisted pageshow is a snapshot restore — the page was hidden
      // for an unknown (likely long) time even if no 'hidden' event fired.
      const snapshotResume = (e as PageTransitionEvent | undefined)?.persisted === true;
      const hiddenFor = now - lastHiddenAtRef.current;
      if ((lastHiddenAtRef.current && hiddenFor > 30000) || snapshotResume) refetchBootstrap();
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('focus', onResume);
    };
  }, [authenticated, refetchBootstrap]);

  // After reconnect (e.g. a device waking from sleep), bootstrap refreshes
  // everything above — no per-resource refetching needed here.

  // Chat history for a directly-opened URL is loaded by the bootstrap fetch
  // above. Navigation between sessions goes through switch-by-id (below).
  const streamHistoryRef = useRef<StreamMessage[]>([]);
  streamHistoryRef.current = streamHistory;

  // Session whose chat content has already been rendered (by bootstrap or a
  // switch-by-id response — both build from the same session file; a second
  // application re-adds the loaded-messages banner and rebuilds the DOM,
  // causing a visible flash on every (re)load).
  const historyRenderedForRef = useRef<string | null>(null);

  // Whether the in-flight switch-by-id was initiated FROM the sessions modal
  // (user clicked a session in the list). Only then does completing the
  // switch close the modal. Automatic switches (SSE reconnect re-sync,
  // id-alias resolution after programmatic navigation) must NOT close a
  // modal the user has open — that made the sessions modal blink shut on
  // devices whenever a background re-sync raced with opening it.

  // When URL changes (browser back/forward, direct navigation, or programmatic
  // navigate), send a switch request. React Router handles the URL — we just
  // react to param changes.
  const prevUrlSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authenticated || !sseConnected || !urlSessionId) return;
    const sid = urlSessionId;
    const urlChanged = prevUrlSessionRef.current !== sid;
    prevUrlSessionRef.current = sid;

    if (sid === sessionState.sessionId) {
      return;
    }
    // Only switch when the URL itself changed (user navigation). A render
    // where only sessionState changed (e.g. the optimistic update from
    // handleNewSession landing before the router updates the URL) must NOT
    // switch the backend — it would switch BACK to the stale URL's session
    // right after creating a new one, sending subsequent messages there.
    if (!urlChanged) return;
    // No session loaded yet (page reload / direct URL entry) → this is an
    // initial load, not a user-initiated switch.
    setSwitchLabel(sessionState.sessionId ? 'Switching session…' : 'Loading session…');
    setSwitchingSession(true);
    fetch(url(API.sessions.activate(sid)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).then(res => res.json()).then(data => {
      // Stale-response guard: only apply if still viewing this session
      if (viewedSessionRef.current !== sid) return;
      // The switch response carries the same bootstrap payload shape as
      // GET /api/bootstrap — apply it with the exact same code path.
      if (data.success && data.data) {
        applyBootstrap(data.data);
        historyRenderedForRef.current = sid;
        setSwitchingSession(false);
        // Close the sessions modal only when the switch was user-initiated
        // from within it (see modalSwitchRef above).

        // The backend may resolve an id alias (e.g. a stale filename id)
        // to the canonical session id — sync the URL to it.
        const resolved = data.data.sessionState?.sessionId;
        if (resolved && resolved !== sid) {
          navigate(`/session/${resolved}`, { replace: true });
        }
      } else if (!data.success) {
        // Surface switch failures (e.g. session cwd vanished) instead of
        // silently leaving the UI on the old session.
        setSessionError(data.error || 'Failed to switch session');
        setSwitchingSession(false);
      }
    }).catch(() => {
      setSwitchingSession(false);
    });
  }, [authenticated, sseConnected, urlSessionId, sessionState.sessionId, creatingSession, applyBootstrap, navigate]);

  // Cancel a queued (steer/follow-up) message: optimistic UI removal; the
  // backend prunes pi's queue and broadcasts history_remove for the
  // committed pending copy in streamHistory.
  const handleCancelPending = useCallback(async (text: string) => {
    setPendingUser((prev) => prev.filter((p) => p.text !== text));
    try {
      await fetch(url(API.session.pending), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sessionId: targetSessionRef.current }),
      });
    } catch {}
  }, []);

  // Badge click: on desktop the status card lives in the always-visible left
  // column — scroll it into view and flash it so the click gives visible
  // feedback. (On mobile onViewChange('status') shows the card full-screen.)
  const handleStatusClick = useCallback(() => {}, []);
  const handleLogout = useCallback(async () => {
    await logout();
    // Full reload to index: resets all SPA state (session view, SSE, modals)
    // and presents a clean login screen. After re-login the app starts from
    // the root redirect as on a fresh visit.
    window.location.href = (basePath() || '/') as string;
  }, [logout]);

  // Spawn the viewed session's pi process on demand (status card "Load").
  const handleActivateSession = useCallback(() => {
    const sid = urlSessionId || sessionState.sessionId;
    if (!sid) return;
    fetch(url(API.sessions.activate(sid)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, spawn: true }),
    }).then((r) => r.json()).then((d) => {
      if (d.success && d.data) applyBootstrap(d.data);
    }).catch(() => {});
  }, [urlSessionId, sessionState.sessionId, applyBootstrap]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try { await fetch(url(API.session.restart), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) }); } catch {}
  }, [setRestarting]);

  const handleRestartBackend = useCallback(async () => {
    if (!confirm('Restart the entire autere backend? All users will be disconnected.')) return;
    setRestartingBackend(true);
    sseDisconnect();
    try { await fetch(url(API.backend.restart), { method: 'POST' }); } catch {}
    setTimeout(() => { sseConnect(); }, 4000);
  }, [setRestartingBackend, sseDisconnect, sseConnect]);

  const handleAbort = useCallback(async () => {
    try { await fetch(url(API.session.abort), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) }); } catch {}
  }, []);

  const handleCompact = useCallback(async () => {
    try {
      const res = await fetch(url(API.session.compact), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) });
      const data = await res.json();
      if (!data.success) setSessionError(data.error || 'Failed to compact');
    } catch (err) {
      console.error('Failed to compact:', err);
      setSessionError('Failed to compact');
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    // Confirm lives at the button (SessionModal) — this handler must fire directly.
    try {
      const res = await fetch(url(API.session.compact), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) });
      const data = await res.json();
      if (!data.success) setSessionError(data.error || 'Failed to abort compaction');
    } catch (err) {
      console.error('Failed to abort compaction:', err);
      setSessionError('Failed to abort compaction');
    }
  }, []);

  const handleNewSession = useCallback((personaId?: string | null, sessionName?: string) => {
    setCreatingSession(true);
    setSessionError(null);
    fetch(url(API.sessions.list), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The modal form prefills this — browser locale + timezone stay authoritative
        sessionName: (sessionName || '').trim() || uiSessionName(),
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(personaId ? { personaId } : {}),
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.navigateUrl) {
          const newId = data.navigateUrl.split('/').pop();
          // Navigate directly from the response — no SSE broadcast needed
          setCreatingSession(false);
                // Apply the fresh session state returned by the backend. The SSE
          // status broadcast for the new session is dropped while we're still
          // on the old URL (stale-snapshot guard), and the URL-change effect
          // early-returns because sessionId was set optimistically — so this
          // response is the only chance to sync sessionName/sessionFile etc.
          // Without it, the session badge keeps the previous session's
          // name/id until the next interaction.
          if (data.sessionState) setSessionState(data.sessionState);
          else if (newId) setSessionState((prev: any) => ({ ...prev, sessionId: newId }));
          resetSessionUI();
          navigate(data.navigateUrl, { replace: true });
        } else if (!data.success) {
          setCreatingSession(false);
          setSessionError(data.error || 'Failed to create session');
        }
      })
      .catch(() => {
        setCreatingSession(false);
        setSessionError('Failed to create session');
      });
  }, [navigate, resetSessionUI]);

  const handleSwitchSession = useCallback((sessionId: string) => {
    setSessionError(null);
    // Mark the upcoming (navigation-triggered) switch as user-initiated so
    // its completion closes the sessions modal. Automatic switches don't.
    // Navigate to the target session — the URL 'view' param defaults to chat,
    // so no explicit view change is needed. (Calling handleSetView('chat')
    // here would navigate BACK to the previous urlSessionId and swallow the
    // switch.) The modal stays open with a "Switching session…" indicator
    // until the switch completes — it's closed on success below.
    navigate(`/session/${sessionId}`);
  }, [navigate]);

  const activeModelId = sessionState.model?.id || null;
  // Optimistic pending copies whose text is already committed to the real
  // history are hidden. Retirement by event ordering is unreliable: the
  // backend broadcasts the user entry (history_upsert) BEFORE the send
  // response returns, so the optimistic copy is created after the real one
  // and no upsert ever targets it again.
  const visiblePendingUser = pendingUser.filter(
    // Retire by prefix too: queued sends get an attachment note appended
    // server-side, so committed text can be pending text + note (same rule
    // the stream_history snapshot retirement uses). Exact match alone kept
    // those copies visible forever.
    (p) => !streamHistory.some((m) => m.role === 'user' && !m.streaming && (m.text === p.text || m.text.startsWith(p.text))),
  );
  const { type: statusType, text: statusText } = computeStatus(baseStatusType, baseStatusText, sessionState);

  if (creatingSession) {
    return (
      <div id="main-app" className={`authenticated view-${activeView}`}>
        <div className="loading-new-session">
            <>
              <div className="loading-spinner" />
              <div className="loading-text">Creating new session…</div>
            </>
        </div>
      </div>
    );
  }

  return (
    <div id="main-app" className={`authenticated view-${activeView}`}>
      <Header
        sessionState={sessionState}
        statusType={statusType}
        statusText={statusText}
        sessionId={targetSessionRef.current}
        sessionName={sessionState.sessionName}
        activeView={activeView}
        onViewChange={handleSetView}
        runningSessions={availableSessions}
        onRunningSessionClick={handleSwitchSession}
        isActive={sessionState.isStreaming || sessionState.compacting}
        userRole={userRole}
      />

      <div className="container">
        <div className="cards-scroll">
          <StatusCard
            statusType={statusType}
            messageCount={sessionState.messageCount}
            requestCount={sessionState.requestCount}
            stats={stats}
            extensions={extensions}
            models={models}
            activeModelId={activeModelId}
            onModelsFetched={setModels}
            username={username}
            userRole={userRole}
            restarting={restarting}
            restartingBackend={restartingBackend}
            onRestart={handleRestart}
            onRestartBackend={handleRestartBackend}
            onLogout={handleLogout}
            persona={sessionState.persona}
            sessionActive={availableSessions.find((x) => x.id === (urlSessionId || sessionState.sessionId))?.active ?? true}
            onActivateSession={handleActivateSession}
            onCompact={handleCompact}
            compacting={sessionState.compacting}
            onAbort={handleAbort}
            isStreaming={sessionState.isStreaming}
          />
        </div>
        <div className="chat-wrapper">
          {activeView === 'sessions' && (
            <SessionView
              statusType={statusType}
              sessionId={sessionState.sessionId}
              sessionName={sessionState.sessionName}
              compacting={sessionState.compacting}
              isStreaming={sessionState.isStreaming}
              onAbort={handleAbort}
              onAbortCompaction={handleAbortCompaction}
              onNewSession={handleNewSession}
              onSwitchSession={handleSwitchSession}
              switching={switchingSession}
            />
          )}
          {activeView === 'chat' && (
            <StreamCard messages={[...streamHistory, ...visiblePendingUser]} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={handleNewSession} onCompact={handleCompact} onCommandError={setSessionError} steerPending={sessionState.steerPending} followUpPending={sessionState.followUpPending} model={sessionState.model} models={models} activeModelId={sessionState.model?.id || null} onModelsFetched={setModels} onSent={(text) => setPendingUser((prev) => [...prev, { role: 'user', text, streaming: false, pending: true, timestamp: Date.now() }])} onCancelPending={handleCancelPending} sessionId={urlSessionId || sessionState.sessionId} />
          )}
                    {activeView === 'settings' && (
            <SettingsCard sseConnected={sseConnected} />
          )}
          {activeView === 'tasks' && (
            <ScheduledTasksCard sseConnected={sseConnected} />
          )}
          {activeView === 'edits' && (
            <div className="card edits-card">
              <EditsPage sessionId={targetSessionRef.current} userRole={userRole} />
            </div>
          )}
          {activeView === 'users' && (
            <UsersCard username={username} />
          )}
        </div>
      </div>


      {switchingSession && (
        <div
          style={{
            position: 'fixed',
            top: '3rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#2563eb',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '0.35rem 1rem',
            borderRadius: '1rem',
            zIndex: 9000,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          {switchLabel}
        </div>
      )}
      <Modal open={!!sessionError} onClose={() => setSessionError(null)} className="modal-status">
        <div className="modal-header">
          <h3>Error</h3>
          <button className="modal-close" onClick={() => setSessionError(null)}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ color: '#f44336' }}>{sessionError}</div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="btn btn-primary" onClick={() => handleNewSession(null)}>Try Again</button>
            <button className="btn" onClick={() => setSessionError(null)}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
