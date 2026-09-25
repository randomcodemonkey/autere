import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { Api, API, saveConfig, type Config } from './api.js';
import { LoginScreen } from './login.js';
import type { HistoryEntry, SessionInfo, SessionState, SessionStats } from './api.js';

import { colors as C } from './colors.js';

const LEFT_WIDTH = 34;
const CHAT_TAIL = 60; // entries rendered — older ones dropped (ponytail: scrollback later)

function fmtTokens(n?: number) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function truncate(s: string, max: number) {
  const line = s.split('\n')[0];
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** One history entry → terminal line(s). Role → color: user amber,
 *  assistant light, thinking dim italic, tool blue, edit pink,
 *  system violet, error red. */
const Entry: React.FC<{ e: HistoryEntry }> = ({ e }) => {
  switch (e.role) {
    case 'user':
      return (
        <Box flexDirection="column" marginTop={e.streaming ? 0 : 1}>
          <Text color={C.user} bold>❯ {e.text}</Text>
        </Box>
      );
    case 'thinking':
      return (
        <Box flexDirection="column">
          <Text color={C.thinking} italic dimColor>· {truncate(e.text, 200)}</Text>
        </Box>
      );
    case 'toolCall':
      return <Text color={C.tool}>⚙ {e.toolCall?.name || 'tool'} {e.toolCall?.cmd ? truncate(e.toolCall.cmd, 80) : ''}</Text>;
    case 'toolResult':
      return <Text color={e.isError ? C.error : C.toolResult}> {truncate(e.text, 140)}</Text>;
    case 'edit':
      return <Text color={C.edit}>✎ {truncate(e.text, 140)}</Text>;
    case 'image':
      return <Text color={C.edit}>🖼 image</Text>;
    case 'file':
      return <Text color={C.edit}>📄 {truncate(e.text, 100)}</Text>;
    case 'system':
      return <Text color={C.system} bold>◆ {truncate(e.text, 200)}</Text>;
    case 'error':
      return <Text color={C.error}>⚠ {truncate(e.text, 200)}</Text>;
    default: // assistant
      return (
        <Box flexDirection="column" marginTop={e.streaming ? 0 : 1}>
          <Text color={e.isError ? C.error : C.assistant}>{e.text}{e.streaming ? '▍' : ''}</Text>
        </Box>
      );
  }
};

const InputBox: React.FC<{
  value: string;
  focus: boolean;
  streaming: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onAbort: () => void;
}> = ({ value, focus, streaming, onChange, onSend, onAbort }) => {
  useInput((input, key) => {
    if (!focus) return;
    if (key.escape) { if (streaming) onAbort(); return; }
    if (key.return) { if (value.trim()) onSend(); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (key.upArrow || key.downArrow || key.tab) return;
    if (input && !key.ctrl && !key.meta) onChange(value + input);
  });
  return (
    <Box borderStyle={focus ? 'round' : 'single'} borderColor={focus ? C.borderFocused : C.border} paddingX={1}>
      <Text color={value ? C.assistant : C.placeholder} wrap="truncate-end">
        {value || (streaming ? 'Esc to abort · type to queue a steer' : 'Type a message…')}
      </Text>
    </Box>
  );
};

export const App: React.FC<{ initialConfig: Config | null; defaultUrl: string }> = ({ initialConfig, defaultUrl }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, bumpResize] = useState(0);
  const [config, setConfig] = useState<Config | null>(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>({});
  const [stats, setStats] = useState<SessionStats>({});
  const [focusInput, setFocusInput] = useState(false);
  const [input, setInput] = useState('');
  const [booting, setBooting] = useState(true);

  const apiRef = useRef<Api | null>(null);
  const viewedRef = useRef<string | null>(null);
  const deltaRef = useRef<{ role: string; text: string } | null>(null);
  const pendingSeq = useRef(0);

  viewedRef.current = viewedId;

  // ── SSE event handling (mirrors DashboardPage semantics) ──
  const handleEvent = useCallback((type: string, data: any, sessionId?: string | null) => {
    switch (type) {
      case 'status':
        setSessionState((prev) => ({ ...prev, ...data }));
        break;
      case 'stats':
        setStats(data || {});
        break;
      case 'stream_history':
        if (!sessionId || sessionId === viewedRef.current) setHistory(data || []);
        break;
      case 'history_upsert':
        if (!sessionId || sessionId === viewedRef.current) {
          setHistory((prev) => {
            const next = [...prev];
            for (const e of data as HistoryEntry[]) {
              // retire optimistic copies with the same text (backend committed the real entry)
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].id.toString().startsWith('p') && next[i].text === e.text) next.splice(i, 1);
              }
              const i = next.findIndex((x) => String(x.id) === String(e.id));
              if (i >= 0) next[i] = e; else next.push(e);
            }
            return next;
          });
        }
        break;
      case 'history_remove':
        if (!sessionId || sessionId === viewedRef.current) {
          setHistory((prev) => prev.filter((m) => !data.includes(m.id)));
        }
        break;
      case 'stream_delta': {
        // carries only role + current text of the streaming entry
        if (!sessionId || sessionId === viewedRef.current) deltaRef.current = { role: data?.role, text: data?.text ?? '' };
        break;
      }
      case 'sessions':
        setSessions([...(data || [])].sort((a: SessionInfo, b: SessionInfo) => b.lastActivity - a.lastActivity));
        break;
      case 'error':
        setError(typeof data === 'string' ? data : data?.message || 'Session error');
        break;
    }
  }, []);

  // flush throttled deltas into the streaming entry
  useEffect(() => {
    const t = setInterval(() => {
      const d = deltaRef.current;
      if (!d) return;
      deltaRef.current = null;
      setHistory((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].streaming && (prev[i].role === d.role || (d.role === 'assistant' && prev[i].role === 'assistant'))) {
            const next = [...prev];
            next[i] = { ...next[i], text: d.text };
            return next;
          }
        }
        // no streaming entry yet (first token) — create one
        return [...prev, { id: `live-${d.role}`, role: d.role, text: d.text, streaming: true }];
      });
    }, 100);
    return () => clearInterval(t);
  }, []);

  // ── Bootstrap + SSE lifecycle ──
  const connect = useCallback(async (api: Api) => {
    const data = await api.get(API.bootstrap);
    applyBootstrap(data);
    api.sse(handleEvent, () => {
      // reconnect after a short delay
      setTimeout(() => { connect(api).catch(() => {}); }, 3000);
    });
  }, [handleEvent]);

  const applyBootstrap = (data: any) => {
    setSessionState(data.sessionState || {});
    setStats(data.sessionStats || {});
    setSessions([...(data.availableSessions || [])].sort((a: SessionInfo, b: SessionInfo) => b.lastActivity - a.lastActivity));
    setHistory(data.streamHistory || []);
    setViewedId(data.sessionState?.sessionId ?? data.historySessionId ?? null);
    setBooting(false);
  };

  useEffect(() => {
    if (!config) return;
    const api = new Api(config.url, config.token);
    apiRef.current = api;
    // Saved token may be stale/revoked — fall back to the login screen
    api.verify().then((ok) => {
      if (ok) return connect(api);
      setConfig(null);
      setBooting(false);
    }).catch((err) => { setError(`Bootstrap failed: ${err.message}`); setBooting(false); });
    // reconnect whenever config changes (login)
  }, [config, connect]);

  // terminal resize
  useEffect(() => {
    const onResize = () => bumpResize((n) => n + 1);
    stdout?.on('resize', onResize);
    return () => { stdout?.off('resize', onResize); };
  }, [stdout]);

  // ── Actions ──
  const switchTo = async (sessionId: string) => {
    const api = apiRef.current;
    if (!api) return;
    try {
      setError(null);
      const data = await api.post(API.sessions.activate(sessionId), {});
      applyBootstrap(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const send = async () => {
    const api = apiRef.current;
    const sessionId = viewedId;
    const text = input.trim();
    if (!api || !sessionId || !text) return;
    setInput('');
    setHistory((prev) => [...prev, { id: `p${++pendingSeq.current}`, role: 'user', text, streaming: true }]);
    try {
      await api.post(API.session.messages, { sessionId, message: text });
    } catch (err: any) {
      setError(err.message);
      setHistory((prev) => prev.filter((m) => m.text !== text || !String(m.id).startsWith('p')));
    }
  };

  const abort = async () => {
    const api = apiRef.current;
    if (!api || !viewedId) return;
    try { await api.post(`${API.session.abort}?sessionId=${encodeURIComponent(viewedId)}`, {}); } catch {}
  };

  // ── Global keys ──
  const [showHelp, setShowHelp] = useState(false);
  useInput((input, key) => {
    const mod = key.ctrl || key.meta; // Cmd on macOS sends meta
    if (mod && input === 'c') { exit(); process.exit(0); }
    if (mod && input === 'h') { setShowHelp((v) => !v); return; }
    if (showHelp) { setShowHelp(false); return; }
    if (focusInput) return;
    if (input === 'h') { setShowHelp(true); return; }
    if (key.tab) { setFocusInput(true); return; }
    if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIdx((i) => Math.min(sessions.length - 1, i + 1));
    if (key.return && sessions[selectedIdx]) switchTo(sessions[selectedIdx].id);
  });

  // ── Login flow ──
  const doLogin = async (url: string, user: string, password: string) => {
    const cfg = await Api.login(url, user, password);
    saveConfig(cfg);
    setConfig(cfg);
  };

  if (!config) return <LoginScreen defaultUrl={defaultUrl} onLogin={doLogin} />;

  if (showHelp) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={2} paddingY={1} width={60} alignSelf="center" marginTop={2}>
        <Text bold color={C.accent}>Keyboard navigation</Text>
        <Box flexDirection="column" marginTop={1}>
          {[
            ['↑ / ↓', 'select session'],
            ['Enter', 'switch to selected session'],
            ['Tab', 'focus chat input'],
            ['Enter (input)', 'send message'],
            ['Esc (input)', 'abort streaming'],
            ['h', 'toggle this help'],
            ['⌘/Ctrl+C', 'quit'],
          ].map(([k, d]) => (
            <Box key={k} gap={2}>
              <Box width={16}><Text color={C.tool} bold>{k}</Text></Box>
              <Text color={C.assistant}>{d}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}><Text dimColor>⌘ (Cmd) and Ctrl both work for modifier shortcuts.</Text></Box>
        <Text dimColor>Press any key to close…</Text>
      </Box>
    );
  }

  // ── Layout ──
  const rows = stdout?.rows || 24;
  const sessionViewport = Math.max(1, rows - 4);
  const scroll = Math.max(0, Math.min(selectedIdx - sessionViewport + 1, Math.max(0, sessions.length - sessionViewport)));
  const visible = sessions.slice(scroll, scroll + sessionViewport);

  const streaming = !!sessionState.isStreaming;
  const compacting = !!sessionState.compacting;
  const state = compacting ? 'compacting' : streaming ? 'streaming' : sessionState.sessionId ? 'idle' : 'offline';
  const stateColor = compacting ? C.user : streaming ? C.accent : sessionState.sessionId ? C.ok : C.thinking;
  const ctxPct = stats.contextUsage?.usedFraction != null ? Math.round(stats.contextUsage.usedFraction * 100) : null;

  const viewed = viewedId ? sessions.find((s) => s.id === viewedId) : undefined;

  return (
    <Box flexDirection="column" height={rows}>
      {error && (
        <Box paddingX={1}>
          <Text color={C.error} bold>⚠ {error} <Text dimColor>(dismissible on next action)</Text></Text>
        </Box>
      )}
      <Box flexGrow={1} flexDirection="row">
        {/* Sessions pane */}
        <Box width={LEFT_WIDTH} flexDirection="column" borderStyle="round" borderColor={focusInput ? C.border : C.borderFocused}>
          {visible.length === 0 && <Text dimColor> no sessions</Text>}
          {visible.map((s, i) => {
            const idx = i + scroll;
            const selected = idx === selectedIdx;
            const isViewed = s.id === viewedId;
            const name = s.sessionName || s.id.slice(0, 12);
            return (
              <Box key={s.id} paddingLeft={1} backgroundColor={selected ? C.selectedBg : undefined}>
                <Text wrap="truncate-end">
                  <Text color={selected ? C.selectedText : s.streaming ? C.dotStreaming : s.active ? C.dotIdle : C.dotActive}>
                    {s.streaming ? '●' : s.active ? '•' : ' '}
                  </Text>
                  <Text dimColor color={selected ? C.selectedMeta : C.timestamp}>{fmtAgo(s.lastActivity).padStart(4)} </Text>
                  <Text color={selected ? C.selectedText : isViewed ? C.accent : C.sessionIdle} bold={isViewed || selected}>
                    {name}
                  </Text>
                </Text>
              </Box>
            );
          })}
        </Box>
        {/* Chat pane */}
        <Box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
          <Box flexDirection="column" flexGrow={1}>
            {booting ? (
              <Text dimColor>Loading session…</Text>
            ) : history.slice(-CHAT_TAIL).map((e) => <Entry key={String(e.id)} e={e} />)}
          </Box>
          <InputBox
            value={input}
            focus={focusInput && !showHelp}
            streaming={streaming}
            onChange={setInput}
            onSend={send}
            onAbort={abort}
          />
        </Box>
      </Box>
      {/* Status bar — status info only; hints live in the h overlay */}
      <Box backgroundColor={C.barBg} paddingX={1} justifyContent="space-between">
        <Text color={C.assistant} wrap="truncate-end">
          <Text bold color={C.accent}>{viewed?.sessionName || sessionState.sessionName || sessionState.sessionId?.slice(0, 12) || 'no session'}</Text>
          {'  '}
          <Text color={stateColor} bold>{state}</Text>
          {sessionState.steerPending ? <Text color={C.user}> +{sessionState.steerPending} queued</Text> : null}
          {'  '}
          <Text dimColor>{sessionState.model?.name || '—'}</Text>
        </Text>
        <Text color={C.assistant} wrap="truncate-end">
          <Text dimColor wrap="truncate-end">
            msgs {sessionState.messageCount ?? 0} · reqs {sessionState.requestCount ?? 0} · in {fmtTokens(stats.tokens?.input)} · out {fmtTokens(stats.tokens?.output)}
            {stats.cost ? ` · $${stats.cost.toFixed(3)}` : ''}
          </Text>
          {ctxPct != null ? <Text color={ctxPct > 80 ? C.error : C.thinking}> · ctx {ctxPct}%</Text> : null}
          {'  '}
          <Text dimColor>h for help</Text>
        </Text>
      </Box>
    </Box>
  );
};
