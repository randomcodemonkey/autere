import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/** Minimal single-line input (cursor always at end — fine for login fields). */
export const TextField: React.FC<{
  label: string;
  value: string;
  mask?: boolean;
  focus: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}> = ({ label, value, mask, focus, onChange, onSubmit }) => {
  useInput((input, key) => {
    if (!focus) return;
    if (key.return) { onSubmit(); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (key.upArrow || key.downArrow || key.tab || key.escape) return;
    if (input && !key.ctrl && !key.meta) onChange(value + input);
  });
  const shown = mask ? '*'.repeat(value.length) : value;
  return (
    <Box>
      <Box width={12}><Text bold={focus} color={focus ? 'cyan' : undefined}>{label}</Text></Box>
      <Text>{shown}<Text backgroundColor={focus ? 'white' : undefined} color="black"> </Text></Text>
    </Box>
  );
};

export const LoginScreen: React.FC<{
  defaultUrl: string;
  onLogin: (base: string, user: string, password: string) => Promise<void>;
}> = ({ defaultUrl, onLogin }) => {
  const [url, setUrl] = useState(defaultUrl);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [field, setField] = useState(0); // 0=url 1=user 2=password
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (!key.tab && !key.downArrow && !key.upArrow) return;
    setField((f) => key.upArrow ? (f + 2) % 3 : (f + 1) % 3);
  });

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(url.replace(/\/+$/, ''), user.trim(), password);
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1} gap={1} borderStyle="round" borderColor="cyan" width={64} alignSelf="center" marginTop={4}>
      <Text bold color="cyan">autere TUI — login</Text>
      <TextField label="URL" value={url} focus={field === 0 && !busy} onChange={setUrl} onSubmit={() => setField(1)} />
      <TextField label="User" value={user} focus={field === 1 && !busy} onChange={setUser} onSubmit={() => setField(2)} />
      <TextField label="Password" value={password} mask focus={field === 2 && !busy} onChange={setPassword} onSubmit={submit} />
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{busy ? 'Signing in…' : 'Tab/↑↓ to switch fields · Enter to submit'}</Text>
    </Box>
  );
};
