# Autere Testing

```bash
npm run test:cli         # CLI API tests (Jest) — bindings + message format round-trips
npm run test:component   # Cypress component tests, no server needed
npm run test:e2e         # Full app: builds frontend, starts an isolated backend, runs Cypress e2e
npm run test:all         # component + e2e
cy:component:open / cy:e2e:open; SPEC=cypress/e2e/foo.cy.ts npx tsx cypress/e2e/support/run-e2e.ts  # single e2e spec via SPEC env
```

E2e needs pi installed and 9Router configured for model access. Failure screenshots land in `cypress/screenshots/` (wiped each run). CI: run `test:component` + `test:cli` only; e2e requires a backend and model access.
