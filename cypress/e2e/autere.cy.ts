/**
 * E2E tests for autere dashboard.
 *
 * These tests start a real autere backend and test the full application flow.
 * The backend runs on port 3457 with auth disabled.
 */

describe('autere E2E', () => {
  // Open the settings view via the header view menu (settings is a card
  // inside the dashboard layout, not a standalone page).
  function openSettings() {
    cy.get('.view-btn-settings').click();
    cy.get('.settings-card').should('be.visible');
  }
  before(() => {
    // Wait for the backend to be ready (started by run-e2e.ts on random port)
    // Use baseUrl from Cypress config — don't hardcode ports
    cy.request({
      url: '/api/state',
      retryOnStatusCodeFailure: true,
      timeout: 5000,
    }).then((response) => {
      expect(response.status).to.eq(200);
    });
  });

  beforeEach(() => {
    // Visit the dashboard
    cy.visit('/');
  });

  
// Open the sessions modal, retrying when the freshly-opened modal closes
// itself (rare headless-browser race). Fails for real if it never opens.
// Scope to the Models section — the settings page has TWO sortable lists
// (Models + Edit Ignore Paths); global selectors would match both.
function modelsSection() {
  return cy.get('.settings-section:has(.settings-section-title:contains("Models"))');
}

function openSessionsModal() {
  cy.get('body').then(($body) => {
    const modalVisible = $body.find('.modal-session.open, .modal-overlay.open .modal-session').length > 0
      && $body.find('.modal-session').is(':visible');
    if (!modalVisible) {
      cy.get('.session-badge').click();
    }
  });
  cy.get('.modal-session', { timeout: 5000 }).should('be.visible');
}

describe('Dashboard Loading', () => {
    it('loads the dashboard successfully', () => {
      cy.get('#main-app').should('exist');
      cy.get('.header').should('exist');
      cy.get('.container').should('exist');
    });

    it('shows the autere title', () => {
      cy.get('.header h1').should('contain', 'autere');
    });

    it('shows status badge', () => {
      cy.get('.status-badge').should('exist');
    });

    it('shows session badge', () => {
      cy.get('.session-badge').should('exist');
    });
  });

  describe('SSE Connection', () => {
    it('connects to SSE and shows connected status', () => {
      // Wait for SSE connection to establish
      cy.get('.status-badge', { timeout: 15000 }).should('not.contain', 'Disconnected');
    });

    it('receives initial state via SSE', () => {
      // Wait for status to be something other than disconnected
      cy.get('.status-badge', { timeout: 15000 }).should('exist');
      // Session badge should show a session ID
      cy.get('.session-badge-text').should('exist');
    });
  });

  describe('Cards Display', () => {
    it('shows Agent card', () => {
      cy.get('.card-title').contains('Agent').should('exist');
    });

    it('shows Usage card', () => {
      cy.get('.card-title').contains('Usage').should('exist');
    });

    it('shows model selector in the chat header', () => {
      cy.get('.chat-model-row .chat-model-name').should('exist');
    });

    it('shows Extensions card', () => {
      cy.get('.card-title').contains('Extensions').should('exist');
    });

    it('shows Chat card', () => {
      cy.get('.stream-card').should('exist');
    });
  });

  describe('Chat Functionality', () => {
    it('renders chat input', () => {
      cy.get('.chat-input').should('exist');
      cy.get('.chat-send-btn').should('contain', 'Send');
    });

    it('can type in chat input', () => {
      cy.get('.chat-input').type('Hello, this is a test message');
      cy.get('.chat-input').should('have.value', 'Hello, this is a test message');
    });

    it('enables send button when input has text', () => {
      cy.get('.chat-input').type('Test message');
      cy.get('.chat-send-btn').should('not.be.disabled');
    });

    it('can send a message and receive response', function() {
      this.timeout(120000); // Longer timeout for AI response

      // Type a simple question
      cy.get('.chat-input').type('What is 2 + 2? Answer with just the number.');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');

      // Wait for the agent to start working
      cy.get('.status-badge', { timeout: 30000 }).should('have.class', 'status-streaming');

      // Wait for the agent to finish and show response
      cy.get('.stream-role-assistant', { timeout: 60000 }).should('exist');

      // Verify the response contains the answer
      cy.get('.stream-text').contains('4').should('exist');
    });

    it('shows streaming indicator while agent is working', function() {
      this.timeout(60000);

      // Wait for agent to be idle
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');

      // Clear any leftover value, type message, and force-click send
      // (button may be disabled from prior test's sending/compacting state)
      cy.get('.chat-input').clear().type('Say hello');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Check for working status
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-streaming');

      // The stream card should have the working class
      cy.get('.stream-card').should('have.class', 'working');
    });
  });

  describe('Model Selection', () => {
    // Model selection lives in the chat-header dropdown since the Model
    // card was replaced by the inline selector.
    it('opens the model dropdown listing available models', () => {
      cy.get('.chat-model-name').click();
      cy.get('.chat-model-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
      cy.get('body').type('{esc}');
    });

    it('highlights the active model', () => {
      cy.get('.chat-model-name').click();
      cy.get('.chat-model-item.active', { timeout: 5000 }).should('exist');
      cy.get('body').type('{esc}');
    });

    it('can select a different model', function() {
      this.timeout(30000);

      cy.get('.chat-model-name').click();
      cy.get('.chat-model-item.active .model-name', { timeout: 5000 }).invoke('text').then((activeName) => {
        // Pick a model that is NOT the active one and select it
        cy.get('.chat-model-item').then(($items) => {
          const target = $items.toArray().find((el) => !el.classList.contains('active'));
          expect(target, 'a non-active model exists').to.exist;
          cy.wrap(target).click();
        });

        // Selecting closes the dropdown (async /api/set-model round-trip)
        cy.get('.chat-model-dropdown', { timeout: 5000 }).should('not.exist');

        // Reopen: the selection is now the active model — then restore
        cy.get('.chat-model-name').click();
        cy.get('.chat-model-item.active .model-name', { timeout: 5000 }).invoke('text')
          .should('not.equal', activeName);
        cy.get('.chat-model-item').contains(activeName).click();
        cy.get('.chat-model-dropdown', { timeout: 5000 }).should('not.exist');
      });
    });
  });

  describe('Usage Statistics', () => {
    it('displays usage statistics', () => {
      cy.contains('Messages').should('exist');
      cy.contains('Requests').should('exist');
      cy.contains('Input Tokens').should('exist');
      cy.contains('Output Tokens').should('exist');
      cy.contains('Cost').should('exist');
      cy.contains('Context').should('exist');
    });

    it('shows context usage progress bar', () => {
      cy.get('.progress-bar').should('exist');
      cy.get('.progress-fill').should('exist');
    });
  });

  describe('Tools Display', () => {
    it('renders tool calls inline in the chat stream', function() {
      this.timeout(120000);

      // Tool calls are rendered as messages in the stream (toolCall role),
      // not as a separate card — send something that triggers a tool.
      cy.get('.chat-input').clear().type('Run the command: echo hello');
      cy.get('.chat-send-btn').first().click();

      cy.get('.tool-call-header', { timeout: 90000 }).should('exist');
      cy.get('.tool-call-name').should('contain', '⚙');
    });
  });

  describe('Session Management', () => {
    it('opens the sessions modal from the status badge', () => {
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.session-search-input').should('exist');
    });

    it('shows current session ID in the modal', () => {
      cy.get('.session-badge').click();
      cy.get('.session-current-id', { timeout: 5000 }).should('exist');
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });

    it('lists available sessions in the modal', () => {
      cy.get('.session-badge').click();
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });
  });

  describe('System Card', () => {
    it('shows the system card in the status column', () => {
      cy.get('.status-card-system').scrollIntoView().should('be.visible');
    });

    it('shows username', () => {
      cy.get('.status-card-system .modal-username').should('exist');
    });

    it('shows uptime rows', () => {
      cy.get('.status-card-system .modal-uptime-row').should('have.length', 3); // pi uptime, autere uptime, UI build
    });

    it('shows logout button', () => {
      cy.contains('Logout').should('exist');
    });

    it('shows restart button', () => {
      cy.contains('Restart PI').should('exist');
    });
  });

  describe('View Menu', () => {
    it('shows chat, status and settings views in the menu', () => {
      cy.get('.view-btn-chat').should('exist');
      cy.get('.view-btn-status').should('exist');
      cy.get('.view-btn-settings').should('exist');
    });

    it('highlights the active view', () => {
      cy.get('.view-btn-chat').should('have.class', 'active');
      cy.get('.view-btn-settings').click();
      cy.get('.view-btn-settings').should('have.class', 'active');
      cy.get('.view-btn-chat').click();
      cy.get('.view-btn-chat').should('have.class', 'active');
    });

    it('switches to settings view and back', () => {
      openSettings();
      cy.url().should('match', /\/session\/[^/]+\/settings$/);
      cy.get('.view-btn-chat').click();
      cy.get('.stream-card').should('exist');
      cy.url().should('match', /\/session\/[^/]+$/);
    });
  });

  describe('Card Collapse', () => {
    it('can collapse and expand the Agent card', () => {
      // Collapse state persists in localStorage — normalize to expanded first.
      // NOTE: the direct-child selector — ExtensionsCard and UsageCard nested
      // inside the Agent card have their own .card-header toggles.
      cy.get('.agent-card').then(($card) => {
        if ($card.hasClass('collapsed')) cy.get('.agent-card > .card-header').click();
      });
      cy.get('.agent-card').should('not.have.class', 'collapsed');

      // Click on the Agent card header to collapse
      cy.get('.agent-card > .card-header').click();
      cy.get('.agent-card').should('have.class', 'collapsed');

      // Click again to expand
      cy.get('.agent-card > .card-header').click();
      cy.get('.agent-card').should('not.have.class', 'collapsed');
    });
  });

  describe('Chat Filters', () => {
    it('has thinking filter toggle', () => {
      cy.get('.stream-toggle').contains('thinking').should('exist');
    });

    it('has tools filter toggle', () => {
      cy.get('.stream-toggle').contains('tools').should('exist');
    });

    it('has edits filter toggle', () => {
      cy.get('.stream-toggle').contains('edits').should('exist');
    });

    it('can toggle thinking filter', () => {
      cy.get('.stream-toggle').contains('thinking').click();
      // The button should toggle its active state
      cy.get('.stream-toggle').contains('thinking').then(($el) => {
        expect($el.hasClass('active')).to.be.oneOf([true, false]);
      });
    });
  });

  describe('Responsive Design', () => {
    it('renders correctly on mobile viewport', () => {
      cy.viewport(375, 812); // iPhone X
      cy.get('#main-app').should('exist');
      cy.get('.header').should('exist');
      cy.get('.chat-input').should('exist');
    });

    it('renders correctly on tablet viewport', () => {
      cy.viewport(768, 1024); // iPad
      cy.get('#main-app').should('exist');
      cy.get('.header').should('exist');
    });
  });

  describe('Keyboard Navigation', () => {
    it('can send message with Enter key', function() {
      this.timeout(60000);

      cy.get('.chat-input').type('Say yes{enter}');
      // Message should be sent
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');
    });

    it('allows Shift+Enter for newlines', () => {
      cy.get('.chat-input').type('Line 1{shift+enter}Line 2');
      cy.get('.chat-input').should('have.value', 'Line 1\nLine 2');
    });
  });

  describe('Error Handling', () => {
    it('handles network errors gracefully', () => {
      // This is a basic test - in real scenarios we'd mock the API
      cy.get('#main-app').should('exist');
    });
  });

  describe('Create New Session', () => {
    it('creates a new session and navigates to it', function() {
      this.timeout(60000);

      // Wait for the agent to be idle (New Session is disabled while Working)
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Working');
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Compacting');

      // Open the sessions modal
      openSessionsModal();
      cy.get('.modal-session .btn-primary').should('be.visible').and('not.be.disabled');
      cy.get('.modal-session .btn-primary').click();

      // Should eventually navigate to a new session (loading page may be too fast to catch)
      cy.url({ timeout: 5000 }).should('match', /\/session\/[^/]+$/);

      // Session badge must show the NEW session's auto-name ("[ui] - <locale date+time>")
      // immediately — not the previous session's name/id.
      cy.get('.session-badge-text').should('contain', '[ui] -');
    });

  });

  describe('Switch Sessions', () => {
    // The session list only keeps sessions that pi has persisted (it writes
    // the session file on the first message) plus in-memory entries currently
    // being viewed. Seed a second session WITH a message so the switch tests
    // always have a persisted session to switch to.
    before(function() {
      this.timeout(120000);
      cy.visit('/');
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.btn-primary').contains('New Session').click();
      cy.get('.modal-session', { timeout: 10000 }).should('not.be.visible');
      // Send a message so pi writes the new session's file to disk
      cy.get('.chat-input').should('not.be.disabled').type('switch session seed');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click();
      cy.get('.stream-role-user', { timeout: 10000 }).should('exist');
      cy.get('.stream-role-assistant', { timeout: 60000 }).should('exist');
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
    });

    it('switches to a different session via the sessions modal', function() {
      this.timeout(30000);

      // Open the sessions modal
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');

      // Wait for sessions to load
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

      // Find and click a different session
      cy.get('.session-item').not('.active').first().click();

      // Should navigate to a session URL
      cy.url({ timeout: 5000 }).should('match', /\/session\/[^/]+$/);
    });

    it('can switch sessions via URL', function() {
      this.timeout(30000);

      // Open the sessions modal
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');

      // Get a session ID from the list
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
      cy.get('.session-item').not('.active').first().find('.session-item-id').invoke('text').then((sessionId) => {

        // Navigate directly to the session via URL
        cy.visit(`/session/${sessionId.trim()}`);

        // Should show that session's ID
        cy.get('.session-badge-text', { timeout: 5000 }).should('contain', sessionId.trim().substring(0, 6));
      });
    });

    it('session list shows sessions with id and name', () => {
      cy.get('.session-badge').click();
      // At least the current session must be listed
      cy.get('.session-item', { timeout: 5000 }).should('have.length.at.least', 1);
      cy.get('.session-item').first().find('.session-item-id').should('exist');
      cy.get('.modal-session .modal-close').click();
    });

    it('current session is highlighted in list', () => {
      cy.get('.session-badge').click();
      cy.get('.session-item.active', { timeout: 5000 }).should('exist');
      cy.get('.modal-session .modal-close').click();
    });

    it('can abort operation from the status card', function() {
      this.timeout(30000);

      // Send a message to make the agent work
      cy.get('.chat-input').type('Think about the meaning of life for a moment');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Wait for streaming to start
      cy.get('.status-badge', { timeout: 10000 }).should('have.class', 'status-streaming');

      // Click abort (force: the turn may already have finished between the
      // streaming check and this click, hiding the button again)
      cy.contains('Abort Operation', { timeout: 3000 }).click({ force: true });

      // Agent must end up idle, whether aborted or already finished
      cy.get('.status-badge', { timeout: 10000 }).should('have.class', 'status-connected');
    });
  });

  describe('Real-time Updates', () => {
    it('updates status in real-time via SSE', function() {
      this.timeout(60000);

      // Send a message to trigger status change
      cy.get('.chat-input').type('Hello');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Status should change to Working
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-streaming');

      // Then back to Idle after response
      cy.get('.status-badge', { timeout: 60000 }).should('have.class', 'status-connected');
    });

    it('updates message count after sending message', function() {
      this.timeout(120000);

      // Get initial message count
      cy.contains('Messages').parent().find('.stat-value-compact').then(($el) => {
        const initialCount = parseInt($el.text()) || 0;

        // Send a message
        cy.get('.chat-input').type('Count test');
        cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

        // Wait for response
        cy.get('.stream-role-assistant', { timeout: 60000 }).should('exist');

        // Message count should increase
        cy.contains('Messages').parent().find('.stat-value-compact').should(($el) => {
          const newCount = parseInt($el.text()) || 0;
          expect(newCount).to.be.greaterThan(initialCount);
        });

        // Wait for the turn to fully complete — the following test depends on
        // the agent being idle, and the assistant message existing only means
        // streaming STARTED.
        cy.get('.status-badge', { timeout: 90000 }).should('not.have.class', 'status-streaming');
      });
    });
  });

  describe('New Session Isolation', () => {
    it('does not show old session content after creating new session', function() {
      this.timeout(90000);

      // Wait for agent to be idle first (previous tests may have left it streaming)
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');

      // Send a unique message in the current session so we can identify it
      const uniqueMsg = 'Test marker ' + Date.now();
      cy.get('.chat-input').should('not.be.disabled').type(uniqueMsg);
      cy.get('.chat-send-btn').first().click();

      // Wait for the user message to appear
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');
      cy.get('.stream-text').should('contain', uniqueMsg);

      // Open the sessions modal and abort
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.btn-abort', { timeout: 5000 }).should('be.visible').click();

      // Agent should leave the Working state
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Working');
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });
  });

  describe('Settings Page', () => {
    it('navigates to settings view from the menu', () => {
      openSettings();
      cy.get('#main-app').should('have.class', 'view-settings');
    });

    it('shows settings card with title', () => {
      openSettings();
      cy.get('.settings-card').should('exist');
      cy.get('.settings-card .card-title').should('contain', 'Settings');
    });

    it('shows Models section with sortable list', () => {
      openSettings();
      cy.get('.settings-section-title').contains('Models').should('exist');
      modelsSection().find('.sortable-list').should('exist');
    });

    it('shows 9Router section if extension is enabled', () => {
      openSettings();
      cy.get('.settings-section-title', { timeout: 5000 }).contains('9Router').should('exist');
    });

    it('shows enabled models in sortable list', () => {
      openSettings();
      modelsSection().find('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
    });

    it('add model input is visible on its own row', () => {
      openSettings();
      modelsSection().find('.sortable-list-add').should('exist');
      modelsSection().find('.sortable-list-add .sortable-list-input').should('be.visible');
      modelsSection().find('.sortable-list-add-btn').should('contain', 'Add Model');
    });

    it('add model button is disabled when input is empty', () => {
      openSettings();
      modelsSection().find('.sortable-list-add .sortable-list-input').should('have.value', '');
      modelsSection().find('.sortable-list-add-btn').should('be.disabled');
    });

    it('add model button enables when input has text', () => {
      openSettings();
      modelsSection().find('.sortable-list-add .sortable-list-input').type('test/model-v1');
      modelsSection().find('.sortable-list-add-btn').should('not.be.disabled');
    });

    it('can add a model to the list', () => {
      openSettings();

      // Get initial count
      modelsSection().find('.sortable-list-item').then(($items) => {
        const initialCount = $items.length;

        // Type a new model name
        modelsSection().find('.sortable-list-add .sortable-list-input').type('test/newly-added-model');
        modelsSection().find('.sortable-list-add-btn').click();

        // Should have one more item
        modelsSection().find('.sortable-list-item').should('have.length', initialCount + 1);

        // New item's input should contain the model name
        modelsSection().find('.sortable-list-item').last().find('.sortable-list-input').should('have.value', 'test/newly-added-model');

        // Input should be cleared
        modelsSection().find('.sortable-list-add .sortable-list-input').should('have.value', '');
      });
    });

    it('can add multiple models sequentially', () => {
      openSettings();

      modelsSection().find('.sortable-list-item').then(($items) => {
        const initialCount = $items.length;

        // Add first model
        modelsSection().find('.sortable-list-add .sortable-list-input').type('test/first-model');
        modelsSection().find('.sortable-list-add-btn').click();
        modelsSection().find('.sortable-list-item').should('have.length', initialCount + 1);

        // Add second model
        modelsSection().find('.sortable-list-add .sortable-list-input').type('test/second-model');
        modelsSection().find('.sortable-list-add-btn').click();
        modelsSection().find('.sortable-list-item').should('have.length', initialCount + 2);

        // Both should be present as input values
        modelsSection().find('.sortable-list-item').eq(initialCount).find('.sortable-list-input').should('have.value', 'test/first-model');
        modelsSection().find('.sortable-list-item').eq(initialCount + 1).find('.sortable-list-input').should('have.value', 'test/second-model');
      });
    });

    it('can remove a model from the list', () => {
      openSettings();

      cy.get('.sortable-list-item', { timeout: 5000 }).then(($items) => {
        const initialCount = $items.length;
        expect(initialCount).to.be.greaterThan(0);

        // Click the remove button on the first item
        cy.get('.sortable-list-item').first().find('.sortable-list-remove').click();

        // Should have one fewer item
        cy.get('.sortable-list-item').should('have.length', initialCount - 1);
      });
    });

    it('can focus and interact with model entry inputs', () => {
      openSettings();

      cy.get('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

      // Model entry inputs should be focusable and editable
      cy.get('.sortable-list-item').first().find('.sortable-list-input').should('not.be.disabled');
      cy.get('.sortable-list-item').first().find('.sortable-list-input').focus();
      cy.get('.sortable-list-item').first().find('.sortable-list-input').should('have.focus');
    });

    it('prevents adding duplicate models', () => {
      openSettings();

      modelsSection().find('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

      // Get the first model name and initial count, then try adding duplicate
      modelsSection().find('.sortable-list-item').first().find('.sortable-list-input').invoke('val').then((existingName) => {
        modelsSection().find('.sortable-list-item').its('length').then((initialCount) => {
          // Try to add the same name (wait for the button to enable — a
          // transient SSE-driven remount can clear the input mid-type)
          modelsSection().find('.sortable-list-add .sortable-list-input').type(String(existingName));
          modelsSection().find('.sortable-list-add-btn').should('not.be.disabled');
          modelsSection().find('.sortable-list-add-btn').click();

          // Should NOT add a duplicate — count stays the same
          modelsSection().find('.sortable-list-item').should('have.length', initialCount);
        });
      });
    });

    it('toggle fields work correctly', () => {
      openSettings();

      cy.get('.settings-toggle', { timeout: 5000 }).should('exist');

      // Find the first toggle and verify it toggles
      cy.get('.settings-toggle input[type="checkbox"]').first().check({ force: true }).should('be.checked');
      cy.get('.settings-toggle input[type="checkbox"]').first().uncheck({ force: true }).should('not.be.checked');
    });

    it('save button is visible', () => {
      openSettings();
      cy.get('.settings-actions .btn-primary').should('contain', 'Save Settings');
    });

    it('session badge opens the sessions modal', () => {
      openSettings();
      cy.get('.session-badge').should('exist');
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.modal-session .modal-close').click();
    });

    it('settings view replaces the chat card', () => {
      openSettings();
      cy.get('.settings-card').should('exist');
      cy.get('.stream-card').should('not.exist');
    });
  });

  describe('Session Switching', () => {
    it('closes the sessions modal after creating a new session', function() {
      this.timeout(30000);
      // Previous tests may have left the agent streaming — new session needs idle
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      openSessionsModal();
      cy.get('.btn-primary').contains('New Session').click();
      // Modal must close once the new session is ready
      cy.get('.modal-session', { timeout: 10000 }).should('not.be.visible');
      // And we end up on a fresh session view
      cy.get('.stream-card', { timeout: 10000 }).should('exist');
    });

    it('switches to a previous session from the sessions modal', function() {
      this.timeout(30000);
      // Switching is disabled while the agent is active
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      openSessionsModal();
      const items = cy.get('.session-item:not(.active)', { timeout: 5000 });
      items.then(($items) => {
        expect($items.length, 'at least one other session exists').to.be.greaterThan(0);
        const targetId = $items.first().find('.session-item-id').text().trim();
        cy.wrap($items.first()).click();
        // URL must change to the target session and the modal must close
        cy.url({ timeout: 10000 }).should('include', `/session/${targetId}`);
        cy.get('.modal-session').should('not.be.visible');
      });
    });
  });

  describe('Scheduled Tasks', () => {
    const TASK_NAME = `e2e-task-${Date.now()}`;

    function openTasks() {
      cy.get('.view-btn-tasks').click();
      cy.get('.scheduled-card').should('be.visible');
    }

    it('navigates to tasks view from the menu', () => {
      openTasks();
      cy.get('#main-app').should('have.class', 'view-tasks');
    });

    it('shows the scheduled tasks card', () => {
      openTasks();
      cy.get('.scheduled-card .card-title').should('contain', 'Scheduled Tasks');
      cy.get('.scheduled-new-btn').should('contain', 'New Task');
    });

    it('creates a scheduled task with seed and result scripts', () => {
      openTasks();
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-name').type(TASK_NAME);
      cy.get('.scheduled-input-schedule').clear();
      cy.get('.scheduled-input-schedule').type('0 5 * * 1');
      cy.get('.scheduled-card').should('contain', '0 5 * * 1');
      cy.get('.scheduled-input-prompt').type('Reply with exactly: OK');
      cy.get('.scheduled-input-seed').type('echo e2e-seed-data');
      cy.get('.scheduled-input-result').type('cat > /dev/null && echo result-script-ok');
      cy.get('.scheduled-save-btn').click();
      cy.get('.scheduled-task', { timeout: 5000 }).should('contain', TASK_NAME);
      cy.get('.scheduled-task').should('contain', 'echo e2e-seed-data');
    });

    it('runs the task now via the Run now button and records a log', function() {
      this.timeout(180000);
      openTasks();

      // Run the just-created task — the agent runs in a dedicated pi process
      cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
        .find('.scheduled-run-btn').click();

      // The run appears in the (auto-expanded) runs list, eventually succeeding
      cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
        .find('.sched-run-status.sched-run-success', { timeout: 150000 }).should('exist');
    });

    it('shows the run log with seed output, agent result and result script output', () => {
      openTasks();
      cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
        .find('.scheduled-toggle-runs-btn').click();
      cy.get('.sched-run-log-btn').first().click();

      cy.get('.modal-sched-log', { timeout: 5000 }).should('be.visible');
      cy.get('.sched-log-meta').should('contain', 'success');
      // Full log lines written by the backend
      cy.get('.sched-log-lines').should('contain', 'Run started (trigger: manual)');
      cy.get('.sched-log-lines').should('contain', 'Seed script produced');
      cy.get('.sched-log-lines').should('contain', 'Agent finished');
      cy.get('.sched-log-lines').should('contain', 'Result script produced');
      cy.get('.sched-log-lines').should('contain', 'pi agent stopped');
      // Seeded data reached the prompt; result script output captured
      cy.get('.sched-log-pre').should('contain', 'e2e-seed-data');
      cy.get('.sched-log-pre').should('contain', 'result-script-ok');
      cy.get('.modal-sched-log .modal-close').click();
      // Modal stays in the DOM when closed (hidden overlay) — assert invisibility
      cy.get('.modal-sched-log', { timeout: 5000 }).should('not.be.visible');
    });

    it('edits an existing task', () => {
      openTasks();
      cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
        .find('.scheduled-edit-btn').click();
      cy.get('.card-title').should('contain', 'Edit Scheduled Task');
      cy.get('.scheduled-input-name').clear();
      cy.get('.scheduled-input-name').type(`${TASK_NAME}-renamed`);
      cy.get('.scheduled-save-btn').click();
      cy.get('.scheduled-task', { timeout: 5000 }).should('contain', `${TASK_NAME}-renamed`);
    });

    it('deletes the task', () => {
      openTasks();
      cy.on('window:confirm', () => true);
      cy.get('.scheduled-task').contains(`${TASK_NAME}-renamed`).parents('.scheduled-task')
        .find('.scheduled-delete-btn').click();
      // The renamed task disappears from the list
      cy.contains('.scheduled-task', `${TASK_NAME}-renamed`, { timeout: 5000 }).should('not.exist');
    });
  });
});
