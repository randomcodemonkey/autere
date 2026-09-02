import { defineConfig } from 'cypress';

export default defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
      viteConfig: './src/frontend/vite.config.ts',
    },
    specPattern: 'cypress/component/**/*.cy.{ts,tsx}',
    indexHtmlFile: 'cypress/component/support/index.html',
    supportFile: 'cypress/component/support/component.ts',
    viewportWidth: 1280,
    viewportHeight: 800,
  },
  e2e: {
    baseUrl: 'http://localhost:3457', // overridden at runtime by run-e2e.ts
    specPattern: 'cypress/e2e/**/*.cy.{ts,tsx}',
    supportFile: 'cypress/e2e/support/e2e.ts',
    // Exclude support scripts from webpack bundling
    excludeSpecPattern: ['**/support/*.ts'],
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 3000,
    requestTimeout: 15000,
    responseTimeout: 15000,
    pageLoadTimeout: 30000,
    video: false,
    screenshotOnRunFailure: true,
  },
});
