/**
 * Backend utility function tests.
 * These import and test the REAL shared pure functions — no inline copies.
 */

import { parseCookies, extractFullText, formatToolArgs, dedupHistory, extractImages } from '../../src/shared/format';
import { findSession, type SessionRef } from '../../src/shared/find-session';
import { isRmCommand, extractRmPaths, accumulateUsage, sanitizeUserName, filterModelsByPatterns, matchModelMap, sessionLocaleStamp, autoSessionName } from '../../src/shared/format';
import { pathIsIgnored } from '../../src/shared/edit-ignore';

describe('Backend Utilities (real implementations)', () => {
  describe('matchModelMap', () => {
    const map = { 'z-ai/glm-5.3-flash': 10, 'claude-x': 50 };

    it('matches exact provider/id keys first', () => {
      expect(matchModelMap(map, 'z-ai', 'glm-5.3-flash')).to.equal(10);
    });

    it('matches bare-id keys for any provider', () => {
      expect(matchModelMap(map, 'anthropic', 'claude-x')).to.equal(50);
    });

    it('matches provider-prefixed keys by id suffix (provider drift)', () => {
      expect(matchModelMap(map, 'other', 'glm-5.3-flash')).to.equal(10);
    });

    it('returns undefined for unknown models and missing inputs', () => {
      expect(matchModelMap(map, 'other', 'nope')).to.equal(undefined);
      expect(matchModelMap(undefined, null, null)).to.equal(undefined);
    });
  });

  describe('parseCookies', () => {
    it('parses empty cookie string', () => {
      expect(parseCookies('')).to.deep.equal({});
    });

    it('parses single cookie', () => {
      expect(parseCookies('autere-token=abc123')).to.deep.equal({
        'autere-token': 'abc123'
      });
    });

    it('parses multiple cookies', () => {
      const result = parseCookies('autere-token=abc123; other=value');
      expect(result).to.deep.equal({
        'autere-token': 'abc123',
        'other': 'value'
      });
    });

    it('handles cookies with equals signs in value', () => {
      const result = parseCookies('token=abc=def=ghi');
      expect(result).to.deep.equal({
        'token': 'abc=def=ghi'
      });
    });

    it('handles whitespace around keys and values', () => {
      const result = parseCookies(' token = abc123 ; other = value ');
      expect(result).to.deep.equal({
        'token': 'abc123',
        'other': 'value'
      });
    });
  });

  describe('formatToolArgs', () => {
    it('returns empty string for null args', () => {
      expect(formatToolArgs('bash', null)).to.equal('');
    });

    it('formats bash command', () => {
      expect(formatToolArgs('bash', { command: 'ls -la' })).to.equal('ls -la');
    });

    it('formats read path', () => {
      expect(formatToolArgs('read', { path: '/path/to/file' })).to.equal('/path/to/file');
    });

    it('formats write path', () => {
      expect(formatToolArgs('write', { path: '/path/to/file', content: 'Hello World' })).to.equal('/path/to/file');
    });

    it('formats edit path', () => {
      expect(formatToolArgs('edit', { path: '/path/to/file' })).to.equal('/path/to/file');
    });

    it('falls back to first string value', () => {
      expect(formatToolArgs('unknown', { foo: 'bar' })).to.equal('bar');
    });

    it('returns empty string when no string values', () => {
      expect(formatToolArgs('unknown', { foo: 123 })).to.equal('');
    });

    it('returns empty string when no args at all', () => {
      expect(formatToolArgs('bash', {})).to.equal('');
    });
  });

  describe('extractFullText', () => {
    it('returns empty string for null content', () => {
      expect(extractFullText({ content: null })).to.equal('');
    });

    it('extracts text from assistant message', () => {
      const msg = { role: 'assistant', content: [{ type: 'text', text: 'Hello World' }] };
      expect(extractFullText(msg)).to.equal('Hello World');
    });

    it('joins multiple text blocks', () => {
      const msg = { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
      expect(extractFullText(msg)).to.equal('ab');
    });

    it('extracts text from tool result without prefix (matches streaming)', () => {
      const msg = {
        role: 'toolResult',
        toolName: 'bash',
        content: [{ type: 'text', text: 'command output' }]
      };
      expect(extractFullText(msg)).to.equal('command output');
    });

    it('extracts error text from tool result', () => {
      const msg = {
        role: 'toolResult',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'error message' }]
      };
      expect(extractFullText(msg)).to.equal('[bash error] error message');
    });

    it('shows bare error prefix when errored tool result has no output', () => {
      const msg = { role: 'toolResult', toolName: 'bash', isError: true, content: [] };
      expect(extractFullText(msg)).to.equal('[bash error]');
    });

    it('returns empty string for non-text content types (streaming never shows placeholders)', () => {
      const msg = { role: 'assistant', content: [{ type: 'toolCall' }] };
      expect(extractFullText(msg)).to.equal('');
    });

    it('returns empty string for mixed non-text content', () => {
      const msg = { role: 'assistant', content: [{ type: 'text' }, { type: 'image' }] };
      expect(extractFullText(msg)).to.equal('');
    });

    it('extracts text blocks from assistant messages that also contain thinking', () => {
      const msg = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] };
      expect(extractFullText(msg)).to.equal('answer');
    });
  });

  describe('extractImages', () => {
    it('returns empty for undefined/null content', () => {
      expect(extractImages(undefined)).to.deep.equal([]);
      expect(extractImages(null)).to.deep.equal([]);
      expect(extractImages([])).to.deep.equal([]);
    });

    it('extracts image blocks with mimeType and base64 data', () => {
      const content = [
        { type: 'text', text: 'here' },
        { type: 'image', mimeType: 'image/png', data: 'QUJD' },
      ];
      expect(extractImages(content)).to.deep.equal([{ mimeType: 'image/png', data: 'QUJD' }]);
    });

    it('defaults missing mimeType to image/png and skips blocks without data', () => {
      const content = [
        { type: 'image', data: 'QQ==' },
        { type: 'image', mimeType: 'image/jpeg' },
      ];
      expect(extractImages(content)).to.deep.equal([{ mimeType: 'image/png', data: 'QQ==' }]);
    });
  });

  describe('dedupHistory', () => {
    it('returns empty array for empty input', () => {
      expect(dedupHistory([])).to.deep.equal([]);
    });

    it('preserves unique messages', () => {
      const messages = [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'assistant', text: 'Hi', timestamp: 2 }
      ];
      expect(dedupHistory(messages)).to.have.length(2);
    });

    it('removes exact duplicates (same role, text and timestamp)', () => {
      const messages = [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'user', text: 'Hello', timestamp: 1 },
      ];
      const result = dedupHistory(messages);
      expect(result).to.have.length(1);
      expect(result[0].text).to.equal('Hello');
    });

    it('keeps messages with same text but different timestamps', () => {
      const messages = [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'user', text: 'Hello', timestamp: 2 },
      ];
      expect(dedupHistory(messages)).to.have.length(2);
    });

    it('deduplicates thinking messages by text regardless of timestamp', () => {
      const messages = [
        { role: 'thinking', text: 'Thinking...', timestamp: 1 },
        { role: 'thinking', text: 'Thinking...', timestamp: 2 }
      ];
      const result = dedupHistory(messages);
      expect(result).to.have.length(1);
      expect(result[0].timestamp).to.equal(2);
    });

    it('keeps streaming messages separate from non-streaming with same content', () => {
      const messages = [
        { role: 'assistant', text: 'Hello', streaming: true, timestamp: 1 },
        { role: 'assistant', text: 'Hello', streaming: false, timestamp: 1 }
      ];
      const result = dedupHistory(messages);
      expect(result).to.have.length(2);
    });
  });

  describe('findSession', () => {
    const sessions: SessionRef[] = [
      { id: 'aaaa1111-0000', sessionFile: '/sessions/aaaa1111-0000.jsonl' },
      { id: 'bbbb2222-0000', sessionFile: '/sessions/old-name.jsonl' },   // filename differs from id (id drift)
      { id: 'cccc3333-0000', sessionFile: '/sessions/CCCC3333-0000.jsonl' },
    ];

    it('resolves by exact id', () => {
      expect(findSession('aaaa1111-0000', sessions)?.id).to.eq('aaaa1111-0000');
    });

    it('resolves by filename when the header id has drifted', () => {
      // Frontend knows the old filename-derived id; the header id was rewritten
      expect(findSession('bbbb2222-0000', sessions)?.sessionFile).to.eq('/sessions/old-name.jsonl');
      expect(findSession('old-name', sessions)?.id).to.eq('bbbb2222-0000');
    });

    it('matches filenames case-insensitively', () => {
      expect(findSession('cccc3333-0000', sessions)?.id).to.eq('cccc3333-0000');
    });

    it('returns undefined for unknown ids', () => {
      expect(findSession('does-not-exist', sessions)).to.be.undefined;
    });

    it('returns undefined (never throws) for missing/empty ids', () => {
      expect(findSession(undefined as any, sessions)).to.be.undefined;
      expect(findSession(null as any, sessions)).to.be.undefined;
      expect(findSession('', sessions)).to.be.undefined;
    });

    it('returns undefined for empty session lists', () => {
      expect(findSession('aaaa1111-0000', [])).to.be.undefined;
    });

    it('does not match when the query is absent from both ids and filenames', () => {
      expect(findSession('ffff9999', sessions)).to.be.undefined;
    });
  });

  describe('isRmCommand / extractRmPaths', () => {
    it('detects rm commands', () => {
      expect(isRmCommand('rm file.txt')).to.be.true;
      expect(isRmCommand('rm -rf dir')).to.be.true;
      expect(isRmCommand('/bin/rm file')).to.be.true;
      // Known limitation: the prefix match cannot span spaces, so the
      // command word must be the first token — 'sudo rm' is NOT detected.
      expect(isRmCommand('sudo rm file')).to.be.false;
    });

    it('rejects non-rm commands and lookalikes', () => {
      expect(isRmCommand('ls -la')).to.be.false;
      expect(isRmCommand('echo rm')).to.be.false;       // rm not the command
      expect(isRmCommand('rmdir dir')).to.be.false;      // \brm\b matches 'rm' in 'rmdir'? no — word boundary after m
      expect(isRmCommand('')).to.be.false;
      expect(isRmCommand(undefined)).to.be.false;
    });

    it('extracts rm target paths, skipping flags', () => {
      expect(extractRmPaths('rm a.txt b.txt')).to.deep.equal(['a.txt', 'b.txt']);
      expect(extractRmPaths('rm -rf /tmp/x')).to.deep.equal(['/tmp/x']);
      expect(extractRmPaths('rm -f -- a b')).to.deep.equal(['a', 'b']);
      expect(extractRmPaths('ls a b')).to.deep.equal([]);
    });
  });

  describe('accumulateUsage', () => {
    const base = () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });

    it('adds usage fields onto the accumulator', () => {
      const s = base();
      accumulateUsage(s, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } });
      accumulateUsage(s, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } });
      expect(s.tokens).to.deep.equal({ input: 20, output: 10, cacheRead: 4, cacheWrite: 2 });
      // Cost is intentionally NOT accumulated here — it flows through
      // UserSession.setCostTotal/accumulateMessageCost (would double-count
      // catalog-priced messages)
      expect(s.cost).to.eq(0);
    });

    it('tolerates missing usage and missing fields', () => {
      const s = base();
      accumulateUsage(s, undefined);
      accumulateUsage(s, {});
      expect(s.tokens).to.deep.equal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(s.cost).to.eq(0);
    });
  });

  describe('sanitizeUserName', () => {
    it('keeps safe names untouched', () => {
      expect(sanitizeUserName('admin')).to.eq('admin');
      expect(sanitizeUserName('john.doe_1')).to.eq('john.doe_1');
    });

    it('replaces unsafe characters with underscores', () => {
      expect(sanitizeUserName('a b/c')).to.eq('a_b_c');
      expect(sanitizeUserName('../etc')).to.eq('.._etc');
      expect(sanitizeUserName('üser')).to.eq('_ser');
    });
  });

  describe('filterModelsByPatterns', () => {
    const models = [
      { provider: 'openrouter', id: 'mimo-v2.5' },
      { provider: 'openrouter', id: 'minimax-m2' },
      { provider: 'anthropic', id: 'claude-sonnet-4' },
    ];

    it('passes everything through when no patterns are configured', () => {
      expect(filterModelsByPatterns(models, [])).to.have.length(3);
    });

    it('matches full provider/id refs', () => {
      const out = filterModelsByPatterns(models, ['openrouter/mimo-v2.5']);
      expect(out).to.have.length(1);
      expect(out[0].id).to.eq('mimo-v2.5');
    });

    it('matches bare id suffixes across providers', () => {
      const out = filterModelsByPatterns(models, ['mimo-v2.5', 'claude-sonnet-4']);
      expect(out.map(m => m.id)).to.deep.equal(['mimo-v2.5', 'claude-sonnet-4']);
    });

    it('drops non-matching models', () => {
      expect(filterModelsByPatterns(models, ['nonexistent/model'])).to.have.length(0);
    });
  });
});

describe('Session auto-naming helpers', () => {
  describe('sessionLocaleStamp', () => {
    const d = new Date(Date.UTC(2026, 8, 5, 12, 7, 9)); // 2026-09-05 12:07:09 UTC

    it('formats date+time with seconds in the given locale', () => {
      const fi = sessionLocaleStamp({ locale: 'fi-FI', timeZone: 'UTC' }, d);
      const en = sessionLocaleStamp({ locale: 'en-US', timeZone: 'UTC' }, d);
      expect(fi).to.contain('2026').and.to.contain('12').and.to.contain('07').and.to.contain('09');
      // en-US uses a 12-hour clock with seconds: "Sep 5, 2026, 12:07:09 PM"
      expect(en).to.contain('2026').and.to.contain('12:07:09 PM');
    });

    it('converts to the requested IANA time zone', () => {
      // 12:07:09 UTC == 15:07:09 in Helsinki, 05:07:09 in Los Angeles
      const hel = sessionLocaleStamp({ locale: 'en-GB', timeZone: 'Europe/Helsinki' }, d);
      const la = sessionLocaleStamp({ locale: 'en-GB', timeZone: 'America/Los_Angeles' }, d);
      expect(hel).to.contain('15:07:09');
      expect(la).to.contain('05:07:09');
    });

    it('falls back to runtime defaults for invalid locale/time zone tags', () => {
      const stamped = sessionLocaleStamp({ locale: 'not-a-locale-xyz', timeZone: 'Not/A_Zone' }, d);
      expect(stamped).to.be.a('string').and.to.contain('07:09');
    });
  });

  describe('autoSessionName', () => {
    it('builds "[prefix] - <locale stamp>" names', () => {
      const d = new Date(Date.UTC(2026, 8, 5, 12, 7, 9));
      expect(autoSessionName('[ui]', { locale: 'en-US' }, d)).to.match(/^\[ui\] - Sep 5, 2026/);
      expect(autoSessionName('[task]', { locale: 'en-US' }, d)).to.match(/^\[task\] - Sep 5, 2026/);
    });
  });

  describe('pathIsIgnored', () => {
    const entries = ['pg', 'pgdata', '/home/autere/pgdata', '/tmp'];

    it('ignores a bare folder name as any path segment, any depth', () => {
      expect(pathIsIgnored('/home/autere/pgdata/x/y.ts', entries)).to.eq(true);
      expect(pathIsIgnored('pgdata/x.ts', entries)).to.eq(true);
      expect(pathIsIgnored('/repo/pg/lib/a.ts', entries)).to.eq(true);
    });

    it('requires all parts of an absolute entry, in order', () => {
      const abs = ['/home/autere/pgdata'];
      expect(pathIsIgnored('/home/autere/pgdata/x.ts', abs)).to.eq(true);
      // Not under that location — and no bare-name entry to match at depth.
      expect(pathIsIgnored('/var/home/autere/pgdata/x.ts', abs)).to.eq(false);
    });

    it('matches segments exactly — no substring hits', () => {
      expect(pathIsIgnored('/repo/pgdatav2/x.ts', entries)).to.eq(false);
      expect(pathIsIgnored('/tmpdir/x.ts', entries)).to.eq(false);
    });

    it('ignores .git at any depth without an entry', () => {
      expect(pathIsIgnored('/repo/.git/config', [''])).to.eq(true);
      expect(pathIsIgnored('/repo/x/.git/hooks/f', entries)).to.eq(true);
    });

    it('tolerates trailing slashes and empty entries', () => {
      expect(pathIsIgnored('/tmp/f.txt', ['/tmp/', ''])).to.eq(true);
    });
  });
});
