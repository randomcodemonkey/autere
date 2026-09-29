import React from 'react';
import { Box, Text } from 'ink';
import { colors as C } from './colors.js';

/**
 * Minimal terminal markdown renderer for assistant replies. Handles what
 * responses actually contain: headings, bold/italic/inline-code/links,
 * bullet + numbered lists, fenced code blocks, blockquotes, tables and
 * horizontal rules. Unknown syntax falls back to plain text (ponytail:
 * swap for a fuller renderer when assistant docs need the rest).
 */

// ── inline: **bold**, *italic*, `code`, [text](url), ~~strike~~ ──
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

const InlineText: React.FC<{ line: string; color?: string }> = ({ line, color }) => {
  const parts = line.split(INLINE_RE).filter((s) => s !== '');
  return (
    <Text color={color ?? C.assistant} wrap="truncate-end">
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) return <Text key={i} bold>{part.slice(2, -2)}</Text>;
        if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**'))
          return <Text key={i} italic>{part.slice(1, -1)}</Text>;
        if (part.startsWith('`') && part.endsWith('`')) return <Text key={i} color={C.tool}>{part.slice(1, -1)}</Text>;
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) return <Text key={i} color={C.tool} underline>{link[1]}</Text>;
        return part;
      })}
    </Text>
  );
};

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const CodeBlock: React.FC<{ lines: string[]; lang?: string }> = ({ lines, lang }) => (
  <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={C.border} paddingX={1}>
    {lang && <Text dimColor>{lang}</Text>}
    {lines.map((l, i) => <Text key={i} color={C.tool}>{l || ' '}</Text>)}
  </Box>
);

const TableBlock: React.FC<{ rows: string[] }> = ({ rows }) => {
  const grid = rows.map(splitCells);
  if (grid.length === 0) return null;
  // pad rows to the widest, size columns by max cell width (cap 28)
  const cols = Math.max(...grid.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(28, Math.max(...grid.map((r) => (r[c] || '').length), 1)));
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      {grid.map((cells, r) => (
        <Box key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <Box key={c} width={widths[c] + 2} flexDirection="column">
              {rows[r].match(/^[\s|:-]+$/) ? null : (
                <Text color={r === 0 ? C.tool : C.assistant}>{(cells[c] || '').slice(0, widths[c])}</Text>
              )}
              <Text dimColor>{'─'.repeat(widths[c])}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};

const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const out: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const block: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { block.push(lines[i]); i++; }
      i++; // closing fence
      out.push(<CodeBlock key={key++} lang={fence[1] || undefined} lines={block} />);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      // separator row (|---|---|) is the table splitter — keep for underline styling
      out.push(<TableBlock key={key++} rows={rows} />);
      continue;
    }
    const head = line.match(/^(#{1,3})\s+(.*)/);
    if (head) {
      out.push(
        <Text key={key++} bold color={C.accent}>
          {head[1].length === 1 ? '# ' : head[1].length === 2 ? '' : ''}
          {head[2]}
        </Text>
      );
      i++;
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    if (bullet) {
      const depth = Math.floor((line.match(/^\s*/)![0].length) / 2);
      out.push(<Box key={key++} marginLeft={1 + depth}><Text color={C.assistant}>• {bullet[1]}</Text></Box>);
      i++;
      continue;
    }
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)/);
    if (num) {
      out.push(<Box key={key++} marginLeft={1}><Text color={C.assistant}>{num[1]}. {num[2]}</Text></Box>);
      i++;
      continue;
    }
    const quote = line.match(/^>\s?(.*)/);
    if (quote) {
      out.push(<Box key={key++} marginLeft={2}><Text color={C.thinking} italic>│ {quote[1]}</Text></Box>);
      i++;
      continue;
    }
    if (line.trim() === '') { out.push(<Text key={key++}> </Text>); i++; continue; }
    if (line.trim() === '---' || line.trim() === '***') { out.push(<Text key={key++} dimColor>────────</Text>); i++; continue; }
    out.push(<InlineText key={key++} line={line} />);
    i++;
  }
  return <Box flexDirection="column">{out}</Box>;
};

export const MarkdownText: React.FC<{ text: string }> = ({ text }) => <Markdown text={text} />;
