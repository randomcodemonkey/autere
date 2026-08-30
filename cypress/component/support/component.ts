// Component test support file
import { mount } from '@cypress/react18';

// Add mount command to Cypress
declare global {
  namespace Cypress {
    interface Chainable {
      mount: typeof mount;
    }
  }
}

Cypress.Commands.add('mount', mount);
