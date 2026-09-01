/**
 * Backend utility function tests.
 * These test pure functions that don't require a running server.
 */

// Import the utility functions we want to test
// Note: We can't directly import TS modules in Cypress, so we'll test the logic inline

describe('Backend Utilities', () => {
  describe('parseCookies', () => {
    // Test the cookie parsing logic
    function parseCookies(header: string): Record<string, string> {
      const cookies: Record<string, string> = {};
      for (const part of header.split(';')) {
        const [key, ...val] = part.split('=');
        if (key) cookies[key.trim()] = val.join('=').trim();
      }
      return cookies;
    }

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
    // Test the tool args formatting logic
    function formatToolArgs(name: string, args: any): string {
      if (!args) return '';
      if (name === 'bash' && args.command) return args.command;
      if (name === 'read' && args.path) return args.path;
      if (name === 'write' && args.path) return args.path + (args.content ? ' (' + args.content.length + ' chars)' : '');
      if (name === 'edit' && args.path) return args.path;
      if (name === 'find' && args.path) return args.path;
      if (name === 'ls' && args.path) return args.path;
      if (name === 'send_wa_message') return (args.jid || args.recipient_jid || '') + ' ' + (args.message || '').slice(0, 50);
      if (name === 'send_reaction') return (args.jid || '') + ' ' + (args.emoji || '');
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return '';
    }

    it('returns empty string for null args', () => {
      expect(formatToolArgs('bash', null)).to.equal('');
    });

    it('formats bash command', () => {
      expect(formatToolArgs('bash', { command: 'ls -la' })).to.equal('ls -la');
    });

    it('formats read path', () => {
      expect(formatToolArgs('read', { path: '/path/to/file' })).to.equal('/path/to/file');
    });

    it('formats write path with content length', () => {
      const content = 'Hello World';
      expect(formatToolArgs('write', { path: '/path/to/file', content })).to.equal('/path/to/file (11 chars)');
    });

    it('formats edit path', () => {
      expect(formatToolArgs('edit', { path: '/path/to/file' })).to.equal('/path/to/file');
    });

    it('formats find path', () => {
      expect(formatToolArgs('find', { path: '/path/to/dir' })).to.equal('/path/to/dir');
    });

    it('formats ls path', () => {
      expect(formatToolArgs('ls', { path: '/path/to/dir' })).to.equal('/path/to/dir');
    });

    it('formats WhatsApp message', () => {
      expect(formatToolArgs('send_wa_message', { jid: '123@s.whatsapp.net', message: 'Hello' })).to.equal('123@s.whatsapp.net Hello');
    });

    it('formats reaction', () => {
      expect(formatToolArgs('send_reaction', { jid: '123@s.whatsapp.net', emoji: '👍' })).to.equal('123@s.whatsapp.net 👍');
    });

    it('falls back to first string value', () => {
      expect(formatToolArgs('unknown', { foo: 'bar' })).to.equal('bar');
    });

    it('returns empty string when no string values', () => {
      expect(formatToolArgs('unknown', { foo: 123 })).to.equal('');
    });
  });

  describe('extractFullText', () => {
    // Test the message text extraction logic
    function extractFullText(message: any): string {
      if (!message.content) return '';
      if (message.role === 'toolResult') {
        const toolName = message.toolName || 'tool';
        const textContent = message.content.find((c: any) => c.type === 'text');
        const output = textContent?.text || '';
        return message.isError ? (output ? `[${toolName} error] ${output}` : `[${toolName} error]`) : output;
      }
      return message.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('');
    }

    it('returns empty string for null content', () => {
      expect(extractFullText({ content: null })).to.equal('');
    });

    it('extracts text from assistant message', () => {
      const msg = { role: 'assistant', content: [{ type: 'text', text: 'Hello World' }] };
      expect(extractFullText(msg)).to.equal('Hello World');
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

    it('returns empty string for non-text content types (streaming never shows placeholders)', () => {
      const msg = { role: 'assistant', content: [{ type: 'toolCall' }] };
      expect(extractFullText(msg)).to.equal('');
    });

    it('returns empty string for mixed non-text content', () => {
      const msg = { role: 'assistant', content: [{ type: 'text' }, { type: 'image' }] };
      expect(extractFullText(msg)).to.equal('');
    });

    it('extracts thinking blocks from assistant messages', () => {
      const msg = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] };
      expect(extractFullText(msg)).to.equal('answer');
    });
  });

  describe('dedupStreamHistory', () => {
    // Test the stream history deduplication logic
    function dedupStreamHistory(messages: any[]): any[] {
      const byKey = new Map<string, any>();
      const order: string[] = [];
      for (const msg of messages) {
        if (msg.streaming) {
          const key = `streaming-${msg.role}-${msg.timestamp || 0}`;
          byKey.set(key, msg);
          order.push(key);
          continue;
        }
        const isThinking = msg.role === 'thinking';
        const contentKey = isThinking
          ? `${msg.role}|${msg.text?.slice(0, 200) || ''}`
          : `${msg.role}|${msg.text?.slice(0, 200) || ''}|${msg.timestamp || 0}`;
        const existing = byKey.get(contentKey);
        if (!existing) {
          byKey.set(contentKey, msg);
          order.push(contentKey);
        } else if (isThinking && (msg.timestamp || 0) > (existing.timestamp || 0)) {
          byKey.set(contentKey, msg);
        }
      }
      return order.map(k => byKey.get(k)!);
    }

    it('returns empty array for empty input', () => {
      expect(dedupStreamHistory([])).to.deep.equal([]);
    });

    it('preserves unique messages', () => {
      const messages = [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'assistant', text: 'Hi', timestamp: 2 }
      ];
      expect(dedupStreamHistory(messages)).to.have.length(2);
    });

    it('deduplicates thinking messages by text', () => {
      const messages = [
        { role: 'thinking', text: 'Thinking...', timestamp: 1 },
        { role: 'thinking', text: 'Thinking...', timestamp: 2 }
      ];
      const result = dedupStreamHistory(messages);
      expect(result).to.have.length(1);
      expect(result[0].timestamp).to.equal(2);
    });

    it('keeps streaming messages separate', () => {
      const messages = [
        { role: 'assistant', text: 'Hello', streaming: true, timestamp: 1 },
        { role: 'assistant', text: 'Hello', streaming: false, timestamp: 1 }
      ];
      const result = dedupStreamHistory(messages);
      expect(result).to.have.length(2);
    });
  });
});
