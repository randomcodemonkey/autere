#!/usr/bin/env node
/**
 * ANSI→PNG renderer for smoke test captures: replays raw terminal output
 * into a virtual @xterm/headless terminal and rasterizes the buffer with
 * pureimage (DejaVu Sans Mono). One PNG per .raw file in smoke/out/.
 *
 * Usage: node smoke/render.mjs [cols] [rows]
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const pureimage = require('pureimage');

const COLS = parseInt(process.argv[2] || '120', 10);
const ROWS = parseInt(process.argv[3] || '36', 10);
const CELL_W = 8, CELL_H = 16, FONT_SIZE = 13;
const HERE = join(dirname(fileURLToPath(import.meta.url)), 'out');

const FONT_PATHS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
const fontPath = FONT_PATHS.find((p) => existsSync(p));
if (!fontPath) throw new Error('No TTF font found for rendering');
const font = pureimage.registerFont(fontPath, 'mono');
await font.load();

// 16-color palette (dark-theme shades approximating the web dashboard)
const PALETTE = [
  '#1e293b', '#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#e2e8f0',
  '#475569', '#fca5a5', '#86efac', '#fde047', '#93c5fd', '#d8b4fe', '#67e8f9', '#f8fafc',
];
const BG_DEFAULT = '#0b1220';
const FG_DEFAULT = '#e2e8f0';

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 256-palette entries 16..255 (6×6×6 cube + grayscale)
function paletteColor(i) {
  if (i < 16) return hex(PALETTE[i]);
  if (i < 232) {
    const c = i - 16, steps = [0, 95, 135, 175, 215, 255];
    return [steps[Math.floor(c / 36)], steps[Math.floor(c / 6) % 6], steps[c % 6]];
  }
  const g = 8 + (i - 232) * 10;
  return [g, g, g];
}

function rgb(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

function resolveColor(cell, fg) {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return hex(fg ? FG_DEFAULT : BG_DEFAULT);
  const n = fg ? cell.getFgColor() : cell.getBgColor();
  return (fg ? cell.isFgRGB() : cell.isBgRGB()) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : paletteColor(n);
}

for (const file of readdirSync(HERE).filter((f) => f.endsWith('.raw'))) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise((resolve) => term.write(readFileSync(join(HERE, file)), resolve));
  const buf = term.buffer.active;

  const png = pureimage.make(COLS * CELL_W, ROWS * CELL_H);
  const ctx = png.getContext('2d');
  ctx.font = `${FONT_SIZE}pt mono`;
  ctx.textBaseline = 'top';

  // background pass
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cell = buf.getLine(row)?.getCell(col);
      if (!cell) continue;
      ctx.fillStyle = rgb(resolveColor(cell, false));
      ctx.fillRect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    }
  }
  // text pass
  for (let row = 0; row < ROWS; row++) {
    const line = buf.getLine(row);
    if (!line) continue;
    let run = '';
    let runFg = null;
    const flush = (endCol) => {
      if (!run) return;
      ctx.fillStyle = rgb(runFg);
      ctx.fillText(run, (endCol - run.length) * CELL_W, row * CELL_H + 1);
      run = '';
    };
    for (let col = 0; col < COLS; col++) {
      const cell = line.getCell(col);
      if (!cell) { flush(col); continue; }
      const fg = resolveColor(cell, true);
      const ch = cell.getChars() || ' ';
      if (runFg && (fg[0] !== runFg[0] || fg[1] !== runFg[1] || fg[2] !== runFg[2])) flush(col);
      runFg = fg;
      run += ch;
    }
    flush(COLS);
  }

  const out = join(HERE, file.replace('.raw', '.png'));
  await pureimage.encodePNGToStream(png, require('fs').createWriteStream(out));
  console.log('rendered', out);
}
