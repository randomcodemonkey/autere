/**
 * AG-UI protocol endpoint e2e: a RunAgentInput becomes an SSE run-event
 * stream, threads map to pi sessions, and tool calls surface as AG-UI events.
 */

import { waitForBackend } from './support/helpers';

interface AguiEvent { type: string; [key: string]: any }

function parseSse(body: string): AguiEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

function runAgui(threadId: string, text: string, forwardedProps: Record<string, any> = {}) {
  return cy.request({
    method: 'POST',
    url: '/api/v1/agui',
    body: {
      threadId,
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messages: [{ id: 'm1', role: 'user', content: text }],
      tools: [],
      context: [],
      forwardedProps,
    },
    timeout: 150000,
  }).then((res) => {
    const events = parseSse(res.body);
    expect(events.length, 'SSE events').to.be.greaterThan(0);
    return events;
  });
}

const sessionIdOf = (events: AguiEvent[]) =>
  events.find((e) => e.type === 'STATE_SNAPSHOT')?.snapshot?.sessionId;

describe('autere — AG-UI', () => {
  before(() => { waitForBackend(); });

  it('runs a turn and resumes the same session for a known threadId', function() {
    this.timeout(240000);
    const threadId = `e2e-agui-${Date.now()}`;

    runAgui(threadId, '2 + 2').then((events) => {
      expect(events[0].type).to.eq('RUN_STARTED');
      expect(events.at(-1)!.type).to.eq('RUN_FINISHED');
      const delta = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('');
      expect(delta).to.contain('4');
      expect(sessionIdOf(events), 'session id in state snapshot').to.be.a('string');

      runAgui(threadId, '2 + 2').then((second) => {
        expect(second.at(-1)!.type).to.eq('RUN_FINISHED');
        expect(sessionIdOf(second), 'resumed session id').to.eq(sessionIdOf(events));
      });
    });
  });

  it('streams tool calls and results as AG-UI events', function() {
    this.timeout(240000);
    runAgui(`e2e-agui-tool-${Date.now()}`, 'tool').then((events) => {
      const types = events.map((e) => e.type);
      expect(types).to.include('TOOL_CALL_START');
      expect(types).to.include('TOOL_CALL_ARGS');
      expect(types).to.include('TOOL_CALL_END');
      expect(types).to.include('TOOL_CALL_RESULT');
      const result = events.find((e) => e.type === 'TOOL_CALL_RESULT');
      expect(result!.content).to.contain('hello');
      expect(events.at(-1)!.type).to.eq('RUN_FINISHED');
    });
  });
});
