import React from 'react';
import { UsersCard } from '../../src/frontend/components/UsersCard';

const USERS: any[] = [
  {
    username: 'admin',
    role: 'admin',
    mustChangePassword: false,
    allowedDirs: [{ path: '/home/admin/projects', access: 'rw' }],
  },
  {
    username: 'bob',
    role: 'chat',
    mustChangePassword: true,
    allowedDirs: [{ path: '/srv/bob', access: 'read' }],
  },
];

interface Call { url: string; opts?: any }

/** Minimal window.fetch stub (Response internals are fragile under cy stubbing). */
function stubFetch(users: any[], postPath?: string): { calls: Call[]; fetch: any } {
  const calls: Call[] = [];
  const fetch = (url: any, opts?: any) => {
    calls.push({ url: String(url), opts });
    const method = opts?.method || 'GET';
    if (String(url).endsWith('/api/v1/users') && method === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: users }) });
    }
    if (postPath && method === 'POST' && String(url).endsWith(postPath)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: null }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  };
  return { calls, fetch: fetch as any };
}

describe('UsersCard', () => {
  it('renders the user list from GET /api/v1/users', () => {
    cy.stub(window, 'fetch').callsFake(stubFetch(USERS).fetch);
    cy.mount(<UsersCard username="admin" />);
    cy.get('.users-row').should('have.length', 2);
    cy.get('.users-row').contains('admin');
    cy.get('.users-row').contains('bob');
    cy.get('.users-flag').should('exist'); // bob must change password
    cy.get('.users-dirs-count').first().should('contain', '1 dir');
  });

  it('creates a user: POST /api/v1/users with form values, then reloads', () => {
    const { calls, fetch } = stubFetch(USERS, '/api/v1/users');
    const created = USERS.concat([{ username: 'carol', role: 'chat', mustChangePassword: true, allowedDirs: [{ path: '/srv/carol', access: 'rw' }] }]);
    const f = (url: any, opts?: any) => {
      const r = fetch(url, opts);
      // After the POST, the reload returns the list including carol
      if (calls.some((c) => c.opts?.method === 'POST') && (!opts || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: created }) });
      }
      return r;
    };
    cy.stub(window, 'fetch').callsFake(f as any);
    cy.mount(<UsersCard username="admin" />);
    cy.get('.btn-primary').contains('Add user').click();
    cy.get('.users-form input[type="text"]').clear().type('carol');
    cy.get('.users-form input[type="password"]').clear().type('initialpw1');
    cy.get('.users-form select').select('chat');
    // Add one allowed directory (read/write)
    cy.get('.users-dir-add').click();
    cy.get('.users-dir-path').type('/srv/carol');
    cy.get('.users-dir-access').select('rw');
    cy.get('.users-form button[type="submit"]').click();
    cy.then(() => {
      const post = calls.find((c) => c.opts?.method === 'POST');
      expect(post, 'create POST happened').to.be.ok;
      const body = JSON.parse(post!.opts.body);
      expect(body.username).to.eq('carol');
      expect(body.password).to.eq('initialpw1');
      expect(body.role).to.eq('chat');
      expect(body.allowedDirs).to.deep.eq([{ path: '/srv/carol', access: 'rw' }]);
      expect(body.mustChangePassword).to.eq(true);
    });
    cy.get('.users-row').should('have.length', 3);
    cy.get('.users-row').contains('carol');
  });

  it('edits a user: PUT /api/v1/users/<name> with role and dirs', () => {
    const { calls, fetch } = stubFetch(USERS, '/api/v1/users/bob');
    cy.stub(window, 'fetch').callsFake(fetch);
    cy.mount(<UsersCard username="admin" />);
    cy.get('.users-row').contains('bob').parents('.users-row').find('.btn').contains('Edit').click();
    cy.get('.users-field > select').select('control');
    cy.get('.users-form button[type="submit"]').click();
    cy.then(() => {
      const post = calls.find((c) => c.opts?.method === 'PUT' && c.url.endsWith('/api/v1/users/bob'));
      expect(post, 'update POST happened').to.be.ok;
      const body = JSON.parse(post!.opts.body);
      expect(body.role).to.eq('control');
      expect(body.password).to.be.undefined; // empty password = unchanged
    });
  });

  it('deletes a user after confirm', () => {
    const { calls, fetch } = stubFetch(USERS);
    cy.stub(window, 'fetch').callsFake(fetch);
    cy.window().then((win) => cy.stub(win, 'confirm').returns(true));
    cy.mount(<UsersCard username="admin" />);
    cy.get('.users-row').contains('bob').parents('.users-row').find('.btn-danger').click();
    cy.then(() => {
      const del = calls.find((c) => c.opts?.method === 'DELETE');
      expect(del, 'DELETE happened').to.be.ok;
      expect(del!.url).to.contain('/api/v1/users/bob');
    });
  });

  it('disables self-delete', () => {
    cy.stub(window, 'fetch').callsFake(stubFetch(USERS).fetch);
    cy.mount(<UsersCard username="admin" />);
    cy.get('.users-row').contains('admin').parents('.users-row').find('.btn-danger').should('be.disabled');
  });
});