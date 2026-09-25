#!/usr/bin/env tsx
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { loadConfig, type Config } from './api.js';

// Auth priority: --token flag > AUTERE_TOKEN env > saved config (~/.autere/tui.json).
// With a token the TUI connects directly; without one it falls back to the
// interactive login screen (which exchanges user/password for a token).
const args = process.argv.slice(2);
const tokenIdx = args.indexOf('--token');
const token = (tokenIdx >= 0 ? args[tokenIdx + 1] : undefined) || process.env.AUTERE_TOKEN;
const positional = args.find((a, i) => !a.startsWith('--') && !(tokenIdx >= 0 && i === tokenIdx + 1));
const base = (process.env.AUTERE_URL || positional || 'http://localhost:3456').replace(/\/+$/, '');

const initialConfig: Config | null = token ? { url: base, token } : loadConfig();
render(<App initialConfig={initialConfig} defaultUrl={base} />);
