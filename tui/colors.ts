import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Color palette with JSON-file overrides.
 *
 * All colors can be redefined in `$AUTERE_DIR/tui-colors.json` (default
 * `~/.autere/tui-colors.json`): unknown keys and invalid values are ignored,
 * everything else falls back to the defaults below. Values are hex (#rgb /
 * #rrggbb) or any terminal color ink accepts (named colors, etc.).
 */

export const DEFAULT_COLORS = {
  // chat roles
  user: '#fbbf24',        // amber
  assistant: '#e2e8f0',   // light gray
  thinking: '#64748b',    // dim slate, italic
  tool: '#60a5fa',        // blue
  toolResult: '#475569',
  edit: '#f472b6',        // pink
  system: '#c084fc',      // violet
  error: '#f87171',       // red

  // chrome
  accent: '#22d3ee',      // cyan — focus border, viewed session, streaming
  barBg: '#1e293b',       // status bar background
  ok: '#4ade80',          // green — idle state, active process dot
  border: '#334155',      // unfocused pane border
  borderFocused: '#22d3ee',
  inputBg: undefined as string | undefined,

  // sessions pane
  selectedBg: '#0e7490',
  selectedText: '#ffffff',
  selectedMeta: '#c7d2fe',
  timestamp: '#64748b',
  dotActive: '#475569',
  dotStreaming: '#22d3ee',
  dotIdle: '#4ade80',
  sessionIdle: '#e2e8f0',

  // input box
  placeholder: '#475569',
  steerHint: '#475569',
};

export type Colors = typeof DEFAULT_COLORS;

const AUTERE_DIR = process.env.AUTERE_DIR || join(homedir(), '.autere');
const OVERRIDES_FILE = join(AUTERE_DIR, 'tui-colors.json');

function loadOverrides(): Partial<Colors> {
  try {
    if (!existsSync(OVERRIDES_FILE)) return {};
    const json = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf-8'));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
      if (k in DEFAULT_COLORS && typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out as Partial<Colors>;
  } catch {
    return {}; // malformed file → pure defaults
  }
}

export const colors: Colors = { ...DEFAULT_COLORS, ...loadOverrides() };
