import React, { useState } from 'react';
import { NotificationsSection } from '../../src/frontend/components/NotificationsSection';
import {
  NOTIFICATION_MAX_CONTENT,
  clipNotification,
  shouldNotifyAllDone,
  workedLongEnough,
  validateNotificationContent,
} from '../../src/shared/notifications';
import type { SettingSection } from '../../src/frontend/types';

const section: SettingSection = {
  id: 'notifications',
  label: 'Notifications',
  fields: [
    { key: 'notifyExplicit', label: 'Messages from the agent', type: 'toggle' as const, description: 'sent by the agent' },
    { key: 'notifyTaskStart', label: 'Scheduled task start', type: 'toggle' as const, description: 'a run starts' },
    { key: 'notifyTurnEnd', label: 'Turn end', type: 'toggle' as const, description: 'the agent finished a turn' },
    { key: 'notifyAllDone', label: 'All tasks completed', type: 'toggle' as const, description: 'idle, nothing queued' },
    { key: 'notifyTurnEndAfterMinutes', label: 'Minimum turn length (minutes)', type: 'number' as const, description: 'gates turn end + all done' },
  ],
};

describe('notification content rules (shared)', () => {
  it('accepts content up to the limit', () => {
    expect(validateNotificationContent('x'.repeat(NOTIFICATION_MAX_CONTENT))).to.equal(null);
  });

  it('rejects content over the limit with an explanation', () => {
    const err = validateNotificationContent('x'.repeat(NOTIFICATION_MAX_CONTENT + 1));
    expect(err).to.be.a('string');
    expect(err).to.contain('256');
    expect(err).to.contain(`got ${NOTIFICATION_MAX_CONTENT + 1}`);
  });

  it('rejects missing/blank content and non-strings', () => {
    expect(validateNotificationContent(undefined)).to.equal('content is required');
    expect(validateNotificationContent('   ')).to.equal('content is required');
    expect(validateNotificationContent(42)).to.equal('content is required');
  });

  it('clips to the first 256 characters', () => {
    expect(clipNotification('y'.repeat(500))).to.have.length(NOTIFICATION_MAX_CONTENT);
    expect(clipNotification('short')).to.equal('short');
  });

  it('counts code points, not UTF-16 units, when clipping', () => {
    const emoji = '🙂'.repeat(NOTIFICATION_MAX_CONTENT);
    expect(clipNotification(emoji)).to.equal(emoji);
    expect([...clipNotification(emoji + '🙂')]).to.have.length(NOTIFICATION_MAX_CONTENT);
  });

  it('minimum length: 0/invalid = every time, otherwise the threshold', () => {
    expect(workedLongEnough(0, 0)).to.equal(true);
    expect(workedLongEnough(NaN, 5_000)).to.equal(true);
    expect(workedLongEnough(2, 2 * 60_000 - 1)).to.equal(false);
    expect(workedLongEnough(2, 2 * 60_000)).to.equal(true);
    expect(workedLongEnough(2, 10 * 60_000)).to.equal(true);
  });

  it('all-done: gated by the minimum length, never doubles a turn-end', () => {
    const none = Number.POSITIVE_INFINITY;
    expect(shouldNotifyAllDone({ workedMs: 1_000, msSinceTurnEndNotify: none }, { minMinutes: 0, dedupeMs: 15_000 })).to.equal(true);
    // a turn-end notification just fired for the same moment
    expect(shouldNotifyAllDone({ workedMs: 60 * 60_000, msSinceTurnEndNotify: 3_000 }, { minMinutes: 0, dedupeMs: 15_000 })).to.equal(false);
    expect(shouldNotifyAllDone({ workedMs: 60 * 60_000, msSinceTurnEndNotify: 15_000 }, { minMinutes: 0, dedupeMs: 15_000 })).to.equal(true);
    // same minimum length as turn end, measured over the whole work block
    const min2 = { minMinutes: 2, dedupeMs: 15_000 };
    expect(shouldNotifyAllDone({ workedMs: 2 * 60_000 - 1, msSinceTurnEndNotify: none }, min2)).to.equal(false);
    expect(shouldNotifyAllDone({ workedMs: 2 * 60_000, msSinceTurnEndNotify: none }, min2)).to.equal(true);
  });
});

describe('NotificationsSection', () => {
  it('renders the device block, the toggles and the minimum-length input', () => {
    cy.mount(
      <NotificationsSection
        section={section}
        settings={{ notifyExplicit: true, notifyTaskStart: false, notifyTurnEnd: true, notifyTurnEndAfterMinutes: 3, notifyAllDone: false }}
        handleChange={() => {}}
      />,
    );
    cy.contains('h3.settings-section-title', 'Notifications').should('be.visible');
    cy.contains('.settings-label', 'This device').should('exist');
    cy.get('.settings-field').should('have.length', 6); // device + 5 kinds/options
    for (const label of ['Messages from the agent', 'Scheduled task start', 'Turn end', 'Minimum turn length (minutes)', 'All tasks completed']) {
      cy.contains('.settings-label', label).should('exist');
    }
    cy.get('input[type="checkbox"]').should('have.length', 4);
    cy.get('input[type="checkbox"]').eq(0).should('be.checked');
    cy.get('input[type="checkbox"]').eq(1).should('not.be.checked');
    cy.get('input[type="checkbox"]').eq(2).should('be.checked');
    cy.get('input[type="checkbox"]').eq(3).should('not.be.checked');
    cy.get('input[type="number"]').should('have.length', 1).and('have.value', 3);
  });

  it('reports kind toggles through handleChange (no restart keys touched)', () => {
    const changed: [string, boolean][] = [];
    cy.mount(
      <NotificationsSection
        section={section}
        settings={{ notifyExplicit: true, notifyTaskStart: true, notifyTurnEnd: true, notifyAllDone: true }}
        handleChange={(key, value) => changed.push([key, value])}
      />,
    );
    cy.get('input[type="checkbox"]').eq(1).click();
    cy.then(() => {
      expect(changed).to.deep.equal([['notifyTaskStart', false]]);
    });
  });

  it('reports the minimum turn length as entered', () => {
    // Stateful harness: the real SettingsCard feeds the change back into the
    // value — a static prop would let React re-render the stale value mid-type.
    const Harness: React.FC = () => {
      const [v, setV] = useState<string>(String(0));
      return (
        <NotificationsSection
          section={section}
          settings={{ notifyTurnEndAfterMinutes: v }}
          handleChange={(_key, value) => setV(String(value))}
        />
      );
    };
    cy.mount(<Harness />);
    cy.get('input[type="number"]').clear().type('2').should('have.value', '2');
    cy.get('input[type="number"]').should('have.value', '2');
  });

  it('offers subscription controls when notifications are supported', () => {
    cy.mount(
      <NotificationsSection section={section} settings={{}} handleChange={() => {}} />,
    );
    // Headless Chrome either blocks permission outright or starts neutral —
    // both states must explain what to do instead of rendering nothing.
    cy.get('.settings-description').then(($el) => {
      const text = $el.text();
      expect(text).to.match(/Not subscribed|Subscribed|blocked|does not support/);
    });
  });
});
