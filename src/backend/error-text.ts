/**
 * Provider errors can arrive as a whole HTML document: GitHub serves its
 * "Unicorn!" page for 5xx, and pi-ai passes the body through untouched when the
 * SDK already folded it into `error.message`. Rendering that puts a wall of
 * markup in the chat, so keep the readable part and say what was dropped. The
 * raw text stays in pi's session file - nothing is lost for a bug report.
 */
const HTML_DOC = /<!doctype\s+html|<html[\s>]|<\/html>/i;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LABEL = 'HTML error page';
const MAX_VISIBLE = 200;

export function cleanProviderError(text: string): string {
  const raw = String(text ?? '');
  const start = raw.search(HTML_DOC);
  if (start < 0) return raw;

  const html = raw.slice(start);
  const title = collapse(decodeEntities(html.match(TITLE)?.[1] ?? ''));
  const visible = collapse(
    decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|title)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' '),
    ),
  );
  const head = raw.slice(0, start).trim().replace(/:\s*\d{3}$/, ':');
  const label = title ? `${LABEL} ("${title}")` : LABEL;
  const kb = Math.max(1, Math.round(raw.length / 1024));
  return [
    `${head ? `${head} ` : ''}${label}${visible ? `: ${cut(visible, MAX_VISIBLE)}` : ''}`,
    `[${kb} KB of HTML omitted]`,
  ].join(' ');
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const space = slice.lastIndexOf(' ');
  return `${space > max * 0.6 ? slice.slice(0, space) : slice}...`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, d) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" survives as "&lt;"
    .replace(/&[a-zA-Z][a-zA-Z0-9]{1,9};/g, ''); // unknown entities: drop
}
