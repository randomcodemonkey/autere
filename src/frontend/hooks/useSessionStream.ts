import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { url } from '../base-path';
import { API } from '../api-paths';
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

export const EMPTY_STATS: SessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  contextUsage: null,
};

const INITIAL_SESSION_STATE: SessionState = {
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
};

/** All session/streaming state: SSE event handling, bootstrap (re)loads,
 *  switch-by-id and PWA resume re-syncs. Pure state/logic — rendering and
 *  user actions live in pages/AppPage.tsx. */
export function useSessionStream(opts: {
  authenticated: boolean;
  urlSessionId: string | undefined;
  sseConnected: boolean;
  baseStatusType: string;
  pageHandlerRef: React.MutableRefObject<(msg: SSEMessage) => void>;
  setRestarting: (v: boolean) => void;
  onBootstrapped?: () => void;
}) {
  const { authenticated, urlSessionId, sseConnected, baseStatusType, pageHandlerRef, setRestarting, onBootstrapped } = opts;
  const navigate = useNavigate();

  const [sessionState, setSessionState] = useState<SessionState>(INITIAL_SESSION_STATE);
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
  // false until the first bootstrap 'sessions' list arrives — the header
  // shows a loading indicator instead of the tabs row before that
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [switchingSession, setSwitchingSession] = useState(false);
  // Label distinguishes a user-initiated switch ("Switching session…") from
  // a load-time restore via URL / reload ("Loading session…").
  const [switchLabel, setSwitchLabel] = useState('Switching session…');

  // Header quick-switch tabs need fresh active/streaming flags; 'sessions'
  // SSE broadcasts only fire on some actions, so poll the session list.
  useEffect(() => {
    if (!authenticated) return;
    let timer: number | undefined;
    const poll = () => {
      fetch(url(API.sessions.list)).then(r => r.json()).then(d => {
        if (d.success) { setAvailableSessions(d.data); setSessionsLoaded(true); }
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

  // The session the user is viewing — stamped on every session-scoped API
  // call so routing never depends on the (racy) server-side binding.
  const targetSessionRef = useRef<string | null>(null);
  targetSessionRef.current = viewedSessionRef.current;

  const handleSSEMessage = useCallback((msg: SSEMessage) => {
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
        setSessionsLoaded(true);
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
  pageHandlerRef.current = handleSSEMessage;

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
    setSessionsLoaded(true);
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
        if (!d.sessionState?.sessionId && sid && sid !== '-') {
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
        onBootstrapped?.();
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

    // Synthetic "no session" id (RootRedirect failure landing): nothing to
    // activate — the stashed bootstrapError modal carries the reason.
    if (sid === '-') {
      setSwitchingSession(false);
      return;
    }
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
        setSwitchingSession(false);
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
  }, [authenticated, sseConnected, urlSessionId, sessionState.sessionId, applyBootstrap, navigate]);

  return {
    sessionState, setSessionState,
    stats,
    streamHistory,
    pendingUser, setPendingUser,
    extensions,
    models, setModels,
    availableSessions,
    sessionsLoaded,
    sessionError, setSessionError,
    creatingSession, setCreatingSession,
    switchingSession, switchLabel,
    resetSessionUI,
    targetSessionRef,
    applyBootstrap,
  };
}
