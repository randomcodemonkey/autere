/**
 * Full-text search over one session's chat history. Works on the entries
 * stream-history already builds (the roles the chat renders), so a hit is
 * always something the user could see in the chat.
 *
 * ponytail: linear scan of the whole session on each query; a searcher could
 * index an index if a very long session ever makes it feel slow.
 */
export interface SearchHit {
  role: string;
  timestamp?: number;
  /** Short context shown in the result list. */
  snippet: string;
  /** The whole message, so the UI can expand a hit without another request. */
  text: string;
  /** `text` was cut at FULL_TEXT_LIMIT. */
  truncated?: boolean;
}

/** Hard cap on returned hits - the modal says when there are more. */
export const SEARCH_LIMIT = 200;
/** Characters kept around the match. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 110;
/** Shorter queries match everything; the backend answers with no hits. */
export const MIN_QUERY = 2;
/**
 * Cap on the full message shipped with a hit. 200 hits of a huge tool output
 * would otherwise make the response tens of MB; the chat still shows it all.
 */
export const FULL_TEXT_LIMIT = 20_000;

export function searchEntries(
  entries: any[],
  query: string,
  roles: string[] | null,
  limit: number = SEARCH_LIMIT,
): { hits: SearchHit[]; total: number } {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < MIN_QUERY) return { hits: [], total: 0 };
  const wanted = roles && roles.length ? new Set(roles) : null;
  const hits: SearchHit[] = [];
  let total = 0;
  for (const entry of entries) {
    const text = String(entry?.text ?? '');
    const role = String(entry?.role ?? '');
    if (!text || (wanted && !wanted.has(role))) continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    total++;
    // Keep scanning past the cap: the UI reports how many matches exist.
    if (hits.length >= limit) continue;
    hits.push({
      role,
      timestamp: entry?.timestamp,
      snippet: snippetAround(text, at, q.length),
      text: text.length > FULL_TEXT_LIMIT ? text.slice(0, FULL_TEXT_LIMIT) : text,
      ...(text.length > FULL_TEXT_LIMIT ? { truncated: true } : {}),
    });
  }
  return { hits, total };
}

function snippetAround(text: string, at: number, matchLength: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + matchLength + SNIPPET_AFTER);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
