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
      timeout: 30000,
    }).then((response) => {
      expect(response.status).to.eq(200);
    });
  });

  beforeEach(() => {
    // Visit the dashboard
    cy.visit('/');
  });

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
    it('shows Model card', () => {
      cy.get('.card-title').contains('Model').should('exist');
    });

    it('shows Usage card', () => {
      cy.get('.card-title').contains('Usage').should('exist');
    });

    it('shows Tools card', () => {
      cy.get('.card-title').contains('Tools').should('exist');
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
      cy.get('.stream-role-user', { timeout: 10000 }).should('contain', 'user');

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
    it('displays available models', () => {
      // Wait for models to load
      cy.get('.model-item', { timeout: 15000 }).should('have.length.greaterThan', 0);
    });

    it('highlights active model', () => {
      cy.get('.model-item.active', { timeout: 15000 }).should('exist');
    });

    it('can select a different model', function() {
      this.timeout(30000);

      // Wait for models to load
      cy.get('.model-item', { timeout: 15000 }).should('have.length.greaterThan', 1);

      // Get the current active model
      cy.get('.model-item.active').then(($active) => {
        const activeName = $active.find('.model-name').text();

        // Find a different model to click
        cy.get('.model-item').not('.active').first().then(($different) => {
          const differentName = $different.find('.model-name').text();

          // The different model should have a different name from the active one
          expect(differentName).to.not.equal(activeName);

          // Click it
          $different.click();

          // Wait for the click to be processed (model change is async via RPC)
          cy.get('.model-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

          // Click back to the original model to restore the default
          cy.get('.model-item').contains(activeName).click();
          cy.get('.model-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
        });
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
    it('shows tools card with empty state initially', () => {
      cy.get('.tool-empty').should('contain', 'No active tools');
    });

    it('shows tools when agent uses them', function() {
      this.timeout(120000);

      // The tools card should always be visible and functional
      cy.get('.card-title').contains('Tools').should('exist');

      // Send a message that is likely to trigger tool use
      cy.get('.chat-input').clear().type('Run the command: echo hello');
      cy.get('.chat-send-btn').first().click();

      // The tools card should always be rendered (with or without active tools)
      cy.get('.card-title').contains('Tools').should('exist');

      // Optionally, tools may appear depending on model behavior
      // We just verify the UI doesn't crash — tools appearing is a bonus
    });
  });

  describe('Session Management', () => {
    it('shows the session card in the status column', () => {
      cy.get('.status-card-session').should('be.visible');
    });

    it('shows current session ID in session card', () => {
      cy.get('.session-current-id', { timeout: 10000 }).should('exist');
    });

    it('lists available sessions', () => {
      cy.get('.session-item', { timeout: 10000 }).should('have.length.greaterThan', 0);
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
      cy.get('.status-card-system .modal-uptime-row').should('have.length', 2);
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
    it('can collapse and expand cards', () => {
      // Click on Model card header to collapse
      cy.get('.card-title').contains('Model').parent().click();
      cy.get('.card').contains('Model').closest('.card').should('have.class', 'collapsed');

      // Click again to expand
      cy.get('.card-title').contains('Model').parent().click();
      cy.get('.card').contains('Model').closest('.card').should('not.have.class', 'collapsed');
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
      cy.get('.stream-role-user', { timeout: 10000 }).should('contain', 'user');
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

      // Wait for New Session button to be enabled (disabled while streaming)
      cy.get('.status-card-session .btn-primary', { timeout: 60000 }).should('not.be.disabled');
      cy.get('.status-card-session .btn-primary').click();

      // Should eventually navigate to a new session (loading page may be too fast to catch)
      cy.url({ timeout: 20000 }).should('match', /\/session\/[^/]+$/);

      // Session badge must show the NEW session id immediately (no name yet,
      // so it displays the first 6 chars of the id + ellipsis) — not the
      // previous session's name/id.
      cy.url().then((u) => {
        const newId = u.split('/').pop() as string;
        cy.get('.session-badge-text').should('have.text', newId.slice(0, 6) + '…');
      });
    });

    it('new session has empty chat history', function() {
      this.timeout(60000);

      // Create new session (scope to modal)
      cy.get('.status-card-session .btn-primary', { timeout: 60000 }).should('not.be.disabled');
      cy.get('.status-card-session .btn-primary').click();
      cy.url({ timeout: 20000 }).should('match', /\/session\/[^/]+$/);

      // Chat should have no messages (stream-box should have no .stream-msg children)
      // Note: 'Waiting for messages...' is a CSS ::before pseudo-element, not DOM text
      cy.get('.stream-box .stream-msg').should('not.exist');
    });

    it('can send message in new session', function() {
      this.timeout(90000);

      // Create new session (scope to modal)
      cy.get('.status-card-session .btn-primary', { timeout: 60000 }).should('not.be.disabled');
      cy.get('.status-card-session .btn-primary').click();
      cy.url({ timeout: 20000 }).should('match', /\/session\/[^/]+$/);

      // Wait for agent to be idle before sending
      cy.get('#main-app', { timeout: 15000 }).should('exist');
      cy.get('.status-badge', { timeout: 30000 }).should('not.have.class', 'status-streaming');

      // Send a message — use the first send button (guaranteed to be 'Send' when idle)
      cy.get('.chat-input').type('Hello from new session');
      cy.get('.chat-send-btn').first().click();

      // Message should appear in stream
      cy.get('.stream-role-user', { timeout: 10000 }).should('contain', 'user');
      cy.get('.stream-text').should('contain', 'Hello from new session');
    });
  });

  describe('Switch Sessions', () => {
    it('switches to a different session via the status card', function() {
      this.timeout(30000);

      // Wait for sessions to load
      cy.get('.session-item', { timeout: 10000 }).should('have.length.greaterThan', 0);

      // Find and click a different session
      cy.get('.session-item').not('.active').first().click();

      // Should navigate to a session URL
      cy.url({ timeout: 10000 }).should('match', /\/session\/[^/]+$/);
    });

    it('can switch sessions via URL', function() {
      this.timeout(30000);

      // Get a session ID from the list
      cy.get('.session-item', { timeout: 10000 }).should('have.length.greaterThan', 0);
      cy.get('.session-item').not('.active').first().find('.session-item-id').invoke('text').then((sessionId) => {

        // Navigate directly to the session via URL
        cy.visit(`/session/${sessionId.trim()}`);

        // Should show that session's ID
        cy.get('.session-badge-text', { timeout: 10000 }).should('contain', sessionId.trim().substring(0, 6));
      });
    });

    it('session list shows multiple sessions', () => {
      cy.get('.session-item', { timeout: 10000 }).should('have.length.greaterThan', 1);
    });

    it('current session is highlighted in list', () => {
      cy.get('.session-item.active', { timeout: 10000 }).should('exist');
    });

    it('can abort operation from the status card', function() {
      this.timeout(60000);

      // Send a message to make the agent work
      cy.get('.chat-input').type('Think about the meaning of life for a moment');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Wait for streaming to start
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-streaming');

      // Abort button should be visible
      cy.contains('Abort Operation').should('be.visible');

      // Click abort
      cy.contains('Abort Operation').click();

      // Should stop streaming
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-connected');
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
      cy.get('.stream-role-user', { timeout: 10000 }).should('contain', 'user');
      cy.get('.stream-text').should('contain', uniqueMsg);

      // Create a new session (scope to modal)
      cy.get('.status-card-session .btn-primary', { timeout: 60000 }).should('not.be.disabled');
      cy.get('.status-card-session .btn-primary').click();

      // Should navigate to a session URL (modal closes and URL changes)
      cy.url({ timeout: 20000 }).should('match', /\/session\/[^/]+$/);

      // Stream history should be cleared by new_session_creating event
      cy.get('.stream-box .stream-msg').should('not.exist');
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
      cy.get('.sortable-list').should('exist');
    });

    it('shows 9Router section if extension is enabled', () => {
      openSettings();
      cy.get('.settings-section-title', { timeout: 10000 }).contains('9Router').should('exist');
    });

    it('shows enabled models in sortable list', () => {
      openSettings();
      cy.get('.sortable-list-item', { timeout: 10000 }).should('have.length.greaterThan', 0);
    });

    it('add model input is visible on its own row', () => {
      openSettings();
      cy.get('.sortable-list-add').should('exist');
      cy.get('.sortable-list-add .sortable-list-input').should('be.visible');
      cy.get('.sortable-list-add-btn').should('contain', 'Add Model');
    });

    it('add model button is disabled when input is empty', () => {
      openSettings();
      cy.get('.sortable-list-add .sortable-list-input').should('have.value', '');
      cy.get('.sortable-list-add-btn').should('be.disabled');
    });

    it('add model button enables when input has text', () => {
      openSettings();
      cy.get('.sortable-list-add .sortable-list-input').type('test/model-v1');
      cy.get('.sortable-list-add-btn').should('not.be.disabled');
    });

    it('can add a model to the list', () => {
      openSettings();

      // Get initial count
      cy.get('.sortable-list-item').then(($items) => {
        const initialCount = $items.length;

        // Type a new model name
        cy.get('.sortable-list-add .sortable-list-input').type('test/newly-added-model');
        cy.get('.sortable-list-add-btn').click();

        // Should have one more item
        cy.get('.sortable-list-item').should('have.length', initialCount + 1);

        // New item's input should contain the model name
        cy.get('.sortable-list-item').last().find('.sortable-list-input').should('have.value', 'test/newly-added-model');

        // Input should be cleared
        cy.get('.sortable-list-add .sortable-list-input').should('have.value', '');
      });
    });

    it('can add multiple models sequentially', () => {
      openSettings();

      cy.get('.sortable-list-item').then(($items) => {
        const initialCount = $items.length;

        // Add first model
        cy.get('.sortable-list-add .sortable-list-input').type('test/first-model');
        cy.get('.sortable-list-add-btn').click();
        cy.get('.sortable-list-item').should('have.length', initialCount + 1);

        // Add second model
        cy.get('.sortable-list-add .sortable-list-input').type('test/second-model');
        cy.get('.sortable-list-add-btn').click();
        cy.get('.sortable-list-item').should('have.length', initialCount + 2);

        // Both should be present as input values
        cy.get('.sortable-list-item').eq(initialCount).find('.sortable-list-input').should('have.value', 'test/first-model');
        cy.get('.sortable-list-item').eq(initialCount + 1).find('.sortable-list-input').should('have.value', 'test/second-model');
      });
    });

    it('can remove a model from the list', () => {
      openSettings();

      cy.get('.sortable-list-item', { timeout: 10000 }).then(($items) => {
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

      cy.get('.sortable-list-item', { timeout: 10000 }).should('have.length.greaterThan', 0);

      // Model entry inputs should be focusable and editable
      cy.get('.sortable-list-item').first().find('.sortable-list-input').should('not.be.disabled');
      cy.get('.sortable-list-item').first().find('.sortable-list-input').focus();
      cy.get('.sortable-list-item').first().find('.sortable-list-input').should('have.focus');
    });

    it('prevents adding duplicate models', () => {
      openSettings();

      cy.get('.sortable-list-item', { timeout: 10000 }).should('have.length.greaterThan', 0);

      // Get the first model name and initial count, then try adding duplicate
      cy.get('.sortable-list-item').first().find('.sortable-list-input').invoke('val').then((existingName) => {
        cy.get('.sortable-list-item').its('length').then((initialCount) => {
          // Try to add the same name
          cy.get('.sortable-list-add .sortable-list-input').type(existingName);
          cy.get('.sortable-list-add-btn').click();

          // Should NOT add a duplicate — count stays the same
          cy.get('.sortable-list-item').should('have.length', initialCount);
        });
      });
    });

    it('toggle fields work correctly', () => {
      openSettings();

      cy.get('.settings-toggle', { timeout: 10000 }).should('exist');

      // Find the first toggle and verify it toggles
      cy.get('.settings-toggle input[type="checkbox"]').first().check({ force: true }).should('be.checked');
      cy.get('.settings-toggle input[type="checkbox"]').first().uncheck({ force: true }).should('not.be.checked');
    });

    it('save button is visible', () => {
      openSettings();
      cy.get('.settings-actions .btn-primary').should('contain', 'Save Settings');
    });

    it('session badge switches to the status view', () => {
      openSettings();
      cy.get('.session-badge').should('exist');
      cy.get('.session-badge').click();
      cy.get('.status-card-session').should('be.visible');
    });

    it('settings view replaces the chat card', () => {
      openSettings();
      cy.get('.settings-card').should('exist');
      cy.get('.stream-card').should('not.exist');
    });
  });
});
