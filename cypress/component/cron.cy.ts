/**
 * Tests for the shared cron matcher used by the scheduler (backend) and
 * the scheduled tasks UI (validation + human descriptions).
 */

import { parseCronField, validateCron, cronMatches, describeCron } from '../../src/shared/cron';

describe('cron', () => {
  describe('parseCronField', () => {
    it('parses * as the full range', () => {
      expect(parseCronField('*', 0, 59)).to.deep.equal(
        Array.from({ length: 60 }, (_, i) => i));
    });

    it('parses a single value', () => {
      expect(parseCronField('15', 0, 59)).to.deep.equal([15]);
    });

    it('parses lists', () => {
      expect(parseCronField('1,5,9', 0, 59)).to.deep.equal([1, 5, 9]);
    });

    it('parses ranges', () => {
      expect(parseCronField('1-5', 0, 59)).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it('parses steps', () => {
      expect(parseCronField('*/15', 0, 59)).to.deep.equal([0, 15, 30, 45]);
    });

    it('parses range with step', () => {
      expect(parseCronField('10-20/5', 0, 59)).to.deep.equal([10, 15, 20]);
    });

    it('maps DOW 7 to 0 (Sunday)', () => {
      expect(parseCronField('7', 0, 7)).to.deep.equal([0]);
      expect(parseCronField('0', 0, 7)).to.deep.equal([0]);
    });

    it('returns null for invalid values', () => {
      expect(parseCronField('60', 0, 59)).to.equal(null);
      expect(parseCronField('abc', 0, 59)).to.equal(null);
      expect(parseCronField('5-1', 0, 59)).to.equal(null);
      expect(parseCronField('', 0, 59)).to.equal(null);
      expect(parseCronField('*/0', 0, 59)).to.equal(null);
      expect(parseCronField('1-,5', 0, 59)).to.equal(null);
    });
  });

  describe('validateCron', () => {
    it('accepts valid expressions', () => {
      expect(validateCron('* * * * *')).to.equal(null);
      expect(validateCron('*/15 * * * *')).to.equal(null);
      expect(validateCron('0 9 * * 1-5')).to.equal(null);
      expect(validateCron('30 2 1,15 * 0')).to.equal(null);
    });

    it('rejects wrong field count', () => {
      expect(validateCron('* * * *')).to.include('Expected 5 fields');
      expect(validateCron('* * * * * *')).to.include('Expected 5 fields');
    });

    it('rejects invalid fields', () => {
      expect(validateCron('60 * * * *')).to.include('minute');
      expect(validateCron('* 25 * * *')).to.include('hour');
      expect(validateCron('* * 32 * *')).to.include('day-of-month');
      expect(validateCron('* * * 13 *')).to.include('month');
      expect(validateCron('* * * * 8')).to.include('day-of-week');
      expect(validateCron('a * * * *')).to.include('minute');
    });
  });

  describe('cronMatches', () => {
    const d = (iso: string) => new Date(iso);

    it('matches every minute', () => {
      expect(cronMatches('* * * * *', d('2026-01-15T10:07:00'))).to.be.true;
    });

    it('matches specific minute/hour', () => {
      expect(cronMatches('30 9 * * *', d('2026-01-15T09:30:00'))).to.be.true;
      expect(cronMatches('30 9 * * *', d('2026-01-15T09:31:00'))).to.be.false;
      expect(cronMatches('30 9 * * *', d('2026-01-15T10:30:00'))).to.be.false;
    });

    it('matches step minutes', () => {
      expect(cronMatches('*/15 * * * *', d('2026-01-15T10:45:00'))).to.be.true;
      expect(cronMatches('*/15 * * * *', d('2026-01-15T10:44:00'))).to.be.false;
    });

    it('matches day of week (1-5 = Mon-Fri)', () => {
      // 2026-01-15 is a Thursday
      expect(cronMatches('0 9 * * 1-5', d('2026-01-15T09:00:00'))).to.be.true;
      // 2026-01-17 is a Saturday
      expect(cronMatches('0 9 * * 1-5', d('2026-01-17T09:00:00'))).to.be.false;
      // 2026-01-18 is a Sunday — 0 matches
      expect(cronMatches('0 9 * * 0', d('2026-01-18T09:00:00'))).to.be.true;
      // DOW 7 is also Sunday
      expect(cronMatches('0 9 * * 7', d('2026-01-18T09:00:00'))).to.be.true;
    });

    it('matches day of month and month', () => {
      expect(cronMatches('0 0 1 1 *', d('2026-01-01T00:00:00'))).to.be.true;
      expect(cronMatches('0 0 1 1 *', d('2026-02-01T00:00:00'))).to.be.false;
    });

    it('DOM and DOW restricted: either matches (standard cron)', () => {
      // 2026-01-15 Thu (dow=4), dom=1 fails, dow matches → true
      expect(cronMatches('0 0 1 * 4', d('2026-01-15T00:00:00'))).to.be.true;
      // 2026-01-01 Thu (dow=4), dom=1 matches, dow matches → true
      expect(cronMatches('0 0 1 * 4', d('2026-01-01T00:00:00'))).to.be.true;
      // 2026-01-02 Fri, neither → false
      expect(cronMatches('0 0 1 * 4', d('2026-01-02T00:00:00'))).to.be.false;
    });

    it('returns false for invalid expressions', () => {
      expect(cronMatches('garbage', d('2026-01-15T10:00:00'))).to.be.false;
    });
  });

  describe('describeCron', () => {
    it('describes common patterns', () => {
      expect(describeCron('* * * * *')).to.equal('Every minute');
      expect(describeCron('*/5 * * * *')).to.equal('Every 5 minutes');
      expect(describeCron('0 * * * *')).to.equal('Every hour');
      expect(describeCron('0 9 * * *')).to.equal('Daily at 09:00');
      expect(describeCron('30 8 * * 1-5')).to.equal('Weekdays at 08:30');
      expect(describeCron('0 12 * * 0')).to.equal('Sundays at 12:00');
      expect(describeCron('0 6 1 * *')).to.equal('Monthly (1st) at 06:00');
    });

    it('falls back to the raw expression for complex patterns', () => {
      expect(describeCron('5,25 8 2,14 3 0')).to.equal('5,25 8 2,14 3 0');
    });

    it('falls back to raw expression for invalid input', () => {
      expect(describeCron('nope')).to.equal('nope');
    });
  });
});
