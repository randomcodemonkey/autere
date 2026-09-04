import React from 'react';
import '../../src/frontend/styles.scss';
import { StreamCard } from '../../src/frontend/components/StreamCard';
import type { StreamMessage } from '../../src/frontend/types';

// Build a large (1408x768) PNG at runtime to mimic a real generated image
function makeBigPng(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1408; canvas.height = 768;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 1408, 768);
  return canvas.toDataURL('image/png').split(',')[1];
}

describe('StreamCard', () => {
  it('renders chat title', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.card-title').should('contain', 'Chat');
  });

  it('renders filter buttons', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-toggle').should('have.length', 3);
    cy.get('.stream-toggle').eq(0).should('contain', 'thinking');
    cy.get('.stream-toggle').eq(1).should('contain', 'tools');
    cy.get('.stream-toggle').eq(2).should('contain', 'edits');
  });

  it('renders user messages', () => {
    const messages: StreamMessage[] = [
      { role: 'user', text: 'Hello world', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 1);
    cy.get('.stream-role-user').should('contain', 'user');
    cy.get('.stream-text').should('contain', 'Hello world');
  });

  it('renders assistant messages', () => {
    const messages: StreamMessage[] = [
      { role: 'assistant', text: 'I can help with that.', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-role-assistant').should('contain', 'assistant');
  });

  it('renders streaming indicator for active messages', () => {
    const messages: StreamMessage[] = [
      { role: 'assistant', text: 'Still typing...', streaming: true },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={true} onNewSession={cy.stub()} />);
    cy.get('.stream-cursor').should('exist');
  });

  it('renders thinking messages', () => {
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Let me think about this...', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-role-thinking').should('contain', 'thinking');
  });

  it('shows scroll button when scrolled up, switching label on new messages', () => {
    const messages: StreamMessage[] = Array.from({ length: 60 }, (_, i) => (
      { role: 'user', text: 'Message ' + i, streaming: false }
    ));
    // Fixed-height flex wrapper makes .stream-box actually scrollable
    cy.mount(
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />
      </div>
    );
    // Autoscroll on mount → at bottom → button hidden
    cy.get('.scroll-to-bottom').should('not.exist');
    // Scroll up → button appears with default label
    cy.get('.stream-box').then(($box) => {
      $box[0].scrollTop = 0;
      $box[0].dispatchEvent(new Event('scroll'));
    });
    cy.get('.scroll-to-bottom').should('contain', 'Scroll to bottom');
    // Click → back at bottom → button hidden again
    cy.get('.scroll-to-bottom').click();
    cy.get('.scroll-to-bottom').should('not.exist');
  });

  it('renders tool result messages', () => {
    const messages: StreamMessage[] = [
      { role: 'toolResult', text: '[bash] output here', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-tool-output').should('contain', '[bash] output here');
  });

  it('renders images attached to tool result messages', () => {
    const messages: StreamMessage[] = [
      {
        role: 'toolResult',
        text: 'Here is your image',
        streaming: false,
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-images .stream-image')
      .should('have.length', 1)
      .and('have.attr', 'src', 'data:image/png;base64,aGVsbG8=');
  });

  it('opens image lightbox on click and closes on click', () => {
    const messages: StreamMessage[] = [
      {
        role: 'toolResult',
        text: '',
        streaming: false,
        images: [{ mimeType: 'image/jpeg', data: 'aGVsbG8=' }],
      },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.image-lightbox').should('not.exist');
    cy.get('.stream-images .stream-image').click();
    cy.get('.image-lightbox').should('exist');
    cy.get('.image-lightbox img').should('have.attr', 'src', 'data:image/jpeg;base64,aGVsbG8=');
    cy.get('.image-lightbox').click();
    cy.get('.image-lightbox').should('not.exist');
  });

  it('shows a save button for displayed images', () => {
    const messages: StreamMessage[] = [
      {
        role: 'toolResult',
        text: '',
        streaming: false,
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-images .stream-image-save')
      .should('have.length', 1)
      .and('contain', 'Save image');
  });

  it('renders image-only messages with no text', () => {
    const messages: StreamMessage[] = [
      {
        role: 'toolResult',
        text: '',
        streaming: false,
        images: [{ mimeType: 'image/jpeg', data: 'aGVsbG8=' }],
      },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-images .stream-image').should('have.length', 1);
  });

  it('hides thinking messages when filter is off', () => {
    // Set localStorage to hide thinking
    localStorage.setItem('autere-filter-thinking', 'off');
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Hidden thought', streaming: false },
      { role: 'assistant', text: 'Visible response', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 1);
    cy.get('.stream-text').should('contain', 'Visible response');
  });

  it('shows thinking messages when filter is on', () => {
    localStorage.setItem('autere-filter-thinking', 'on');
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Visible thought', streaming: false },
      { role: 'assistant', text: 'Visible response', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 2);
  });

  it('adds working class when streaming', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={true} onNewSession={cy.stub()} />);
    cy.get('.stream-card').should('have.class', 'working');
  });

  it('renders chat input', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.chat-input').should('exist');
    cy.get('.chat-send-btn').should('contain', 'Send');
  });

  it('shows expand/collapse for long messages', () => {
    const longText = 'A'.repeat(3000);
    const messages: StreamMessage[] = [
      { role: 'assistant', text: longText, streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-text-truncated').should('contain', 'more characters');
  });

  it('shows the active model on the second header row', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={() => {}} model={{ provider: 'openrouter', id: 'mimo-v2.3', name: 'mimo-v2.3:all' }} />);
    cy.get('.chat-model-row').should('contain', 'mimo-v2.3:all');
    cy.get('.chat-model-external').should('not.exist');
  });

  it('scrolls to bottom when a filter toggle is clicked', () => {
    const longText = 'X'.repeat(3000);
    const messages: StreamMessage[] = [
      { role: 'assistant', text: longText, streaming: false },
      { role: 'user', text: 'latest message', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-box').then(($box) => {
      // Start scrolled away from the bottom
      $box[0].scrollTop = 0;
    });
    cy.get('.stream-toggle').contains('tools').click();
    cy.get('.stream-box').then(($box) => {
      const b = $box[0];
      expect(b.scrollHeight - b.scrollTop - b.clientHeight).to.be.lessThan(5);
    });
  });

  it('shows Active on the model row when streaming', () => {
    cy.mount(<StreamCard messages={[]} isStreaming onNewSession={() => {}} model={null} />);
    cy.get('.chat-model-external').should('be.visible').and('contain', 'Active');
  });

  it('shows Active elsewhere and disables chat when externalActivity', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={() => {}} model={null} externalActivity />);
    cy.get('.chat-model-external').should('be.visible').and('contain', 'Active elsewhere');
    cy.get('.chat-send-btn').first().should('be.disabled');
  });

  it('shows a dash on the model row when no model is set', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={() => {}} model={null} />);
    cy.get('.chat-model-name').should('contain.text', '—');
  });
});

describe('image overflow (large image)', () => {
  it('image does not overflow stream-box', () => {
    const data = makeBigPng();
    const messages: StreamMessage[] = [
      { role: 'toolResult', text: '', streaming: false, images: [{ mimeType: 'image/png', data }] },
    ];
    cy.mount(<div style={{ width: 500 }}><StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} /></div>);
    cy.get('.stream-image').should('be.visible');
    cy.get('.stream-box').then(($box) => {
      const box = $box[0];
      const img = box.querySelector('.stream-image') as HTMLImageElement;
      expect(img.complete, 'img loaded').to.be.true;
      expect(img.naturalWidth, 'natural width is large').to.equal(1408);
      expect(img.getBoundingClientRect().width, 'img constrained to box').to.be.lte(box.clientWidth);
      expect(box.scrollWidth, 'no horizontal overflow').to.be.lte(box.clientWidth);
    });
  });
});
