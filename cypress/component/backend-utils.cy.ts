/**
 * Backend utility function tests.
 * These import and test the REAL shared pure functions — no inline copies.
 */

import { parseCookies, extractFullText, formatToolArgs, dedupHistory } from '../../src/shared/format';

describe('Backend Utilities (real implementations)', () => {
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
});
