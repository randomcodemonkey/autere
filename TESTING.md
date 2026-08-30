# Autere Testing

This document describes the testing setup for the autere application.

## Overview

The test suite uses Cypress for both component and end-to-end (e2e) testing:

- **Component Tests**: Test individual React components and utility functions in isolation
- **E2E Tests**: Test the full application flow with a real autere backend

## Running Tests

### Component Tests (no server required)

```bash
# Run all component tests headlessly
npm run cy:component

# Open Cypress component test runner (interactive)
npm run cy:component:open
```

### E2E Tests (requires running backend)

```bash
# Start the backend on test port (3457) with auth disabled
npx tsx src/backend/index.ts --port 3457 --monitor-auth false

# In another terminal, run e2e tests
npm run cy:e2e

# Or open Cypress e2e test runner
npm run cy:e2e:open
```

### All Tests

```bash
# Run component tests (default)
npm test

# Run both component and e2e tests
npm run test:all
```

## Test Structure

```
cypress/
├── component/                    # Component tests
│   ├── support/
│   │   ├── component.ts         # Component test support
│   │   └── index.html           # Mount point for components
│   ├── ChatInput.cy.tsx         # Chat input component tests
│   ├── ExtensionsCard.cy.tsx    # Extensions card tests
│   ├── Header.cy.tsx            # Header component tests
│   ├── LoginScreen.cy.tsx       # Login screen tests
│   ├── Modal.cy.tsx             # Modal component tests
│   ├── ModelCard.cy.tsx         # Model selection card tests
│   ├── SessionModal.cy.tsx      # Session management modal tests
│   ├── StatusBadge.cy.tsx       # Status indicator tests
│   ├── StatusModal.cy.tsx       # Status modal tests
│   ├── StreamCard.cy.tsx        # Chat stream display tests
│   ├── ToolsCard.cy.tsx         # Tools display card tests
│   ├── UsageCard.cy.tsx         # Usage statistics card tests
│   ├── backend-utils.cy.ts      # Backend utility function tests
│   ├── useAuth.cy.tsx           # Authentication hook tests
│   ├── useCardState.cy.tsx      # Card state persistence tests
│   └── useSSE.cy.tsx            # SSE connection hook tests
├── e2e/                          # End-to-end tests
│   ├── support/
│   │   ├── e2e.ts               # E2E test support
│   │   └── start-backend.ts     # Backend startup helper
│   └── autere.cy.ts         # Full application tests
└── screenshots/                  # Test failure screenshots
```

## Component Tests

### What's Tested

1. **UI Components**
   - Rendering with different props
   - User interactions (clicks, input)
   - Conditional rendering
   - CSS class states

2. **Custom Hooks**
   - `useAuth`: Authentication state management
   - `useCardState`: LocalStorage persistence
   - `useSSE`: Server-Sent Events connection

3. **Backend Utilities**
   - Cookie parsing
   - Tool argument formatting
   - Message text extraction
   - Stream history deduplication

### Writing Component Tests

```tsx
import React from 'react';
import { MyComponent } from '../../src/frontend/components/MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    cy.mount(<MyComponent prop="value" />);
    cy.get('.my-component').should('contain', 'value');
  });

  it('handles user interaction', () => {
    const onClick = cy.stub().as('onClick');
    cy.mount(<MyComponent onClick={onClick} />);
    cy.get('.my-button').click();
    cy.get('@onClick').should('have.been.calledOnce');
  });
});
```

## E2E Tests

### Prerequisites

1. Pi must be installed (`npm install -g @earendil-works/pi-coding-agent`)
2. 9Router extension configured for AI model access
3. Port 3457 available

### What's Tested

1. **Dashboard Loading**
   - Page loads successfully
   - Header displays correctly
   - Cards render

2. **SSE Connection**
   - Connects to backend
   - Receives real-time updates

3. **Chat Functionality**
   - Can send messages
   - Receives AI responses
   - Shows streaming indicator

4. **Model Selection**
   - Lists available models
   - Can switch models

5. **Session Management**
   - Opens session modal
   - Lists sessions
   - Can switch sessions

### Running E2E Tests

```bash
# Terminal 1: Start backend
npx tsx src/backend/index.ts --port 3457 --monitor-auth false

# Terminal 2: Run tests
npm run cy:e2e
```

## Debugging

### View Test Screenshots

Failed tests automatically capture screenshots in `cypress/screenshots/`.

### Interactive Mode

Use `cy:component:open` or `cy:e2e:open` to run tests interactively with the Cypress Test Runner.

### Debug in Browser

1. Open Cypress Test Runner
2. Click on a test to run it
3. Use browser DevTools to inspect elements
4. Use `cy.pause()` in tests to pause execution

## CI/CD

For CI environments, run component tests only (no server required):

```bash
npm run cy:component
```

For full integration testing, start the backend before running e2e tests.
