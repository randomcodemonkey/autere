/**
 * Minimal 5-field cron expression matcher (pure functions, no Node deps).
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: * , - / and numeric values. DOW accepts 0-7 (7 = Sunday).
 *
 * Used by the autere scheduler (backend) and validated in the UI.
 */

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week (0 and 7 = Sunday)
];

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

/** Parse one cron field into the list of matching values, or null on error */
export function parseCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (!part) return null;

    // step: "*/n" or "a-b/n" or "a/n"
    let expr = part;
    let step = 1;
    const slashIdx = expr.indexOf('/');
    if (slashIdx !== -1) {
      const stepStr = expr.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepStr) || parseInt(stepStr, 10) < 1) return null;
      step = parseInt(stepStr, 10);
      expr = expr.slice(0, slashIdx);
    }

    let rangeMin = min;
    let rangeMax = max;
    if (expr !== '*' && expr !== '?') {
      const dashIdx = expr.indexOf('-');
      if (dashIdx !== -1) {
        const a = expr.slice(0, dashIdx);
        const b = expr.slice(dashIdx + 1);
        if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
        rangeMin = parseInt(a, 10);
        rangeMax = parseInt(b, 10);
      } else {
        if (!/^\d+$/.test(expr)) return null;
        const v = parseInt(expr, 10);
        if (step > 1) {
          // "5/10" means start at 5, step 10, to max
          rangeMin = v;
        } else {
          if (v < min || v > max) return null;
          // DOW: treat 7 as 0 (Sunday)
          values.add(v === 7 && max === 7 ? 0 : v);
          continue;
        }
      }
    }

    // DOW: map 7 to 0
    if (max === 7) rangeMax = Math.min(rangeMax, 7);
    if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) return null;
    for (let v = rangeMin; v <= rangeMax; v += step) {
      values.add(v === 7 && max === 7 ? 0 : v);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Validate a cron expression. Returns null when valid, or an error message.
 */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }
  for (let i = 0; i < 5; i++) {
    const parsed = parseCronField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!parsed || parsed.length === 0) {
      return `Invalid ${FIELD_NAMES[i]} field: "${fields[i]}"`;
    }
  }
  return null;
}

/** Whether the given date matches the cron expression */
export function cronMatches(expr: string, date: Date): boolean {
  if (validateCron(expr) !== null) return false;
  const fields = expr.trim().split(/\s+/);
  const minute = parseCronField(fields[0], 0, 59)!;
  const hour = parseCronField(fields[1], 0, 23)!;
  const dom = parseCronField(fields[2], 1, 31)!;
  const month = parseCronField(fields[3], 1, 12)!;
  const dow = parseCronField(fields[4], 0, 7)!;

  if (!minute.includes(date.getMinutes())) return false;
  if (!hour.includes(date.getHours())) return false;
  if (!month.includes(date.getMonth() + 1)) return false;

  const dayMatchesDom = dom.includes(date.getDate());
  const dayMatchesDow = dow.includes(date.getDay());
  // Standard cron semantics: if both DOM and DOW are restricted, either may match.
  const domRestricted = fields[2] !== '*' && fields[2] !== '?';
  const dowRestricted = fields[4] !== '*' && fields[4] !== '?';
  if (domRestricted && dowRestricted) {
    return dayMatchesDom || dayMatchesDow;
  }
  return dayMatchesDom && dayMatchesDow;
}

/**
 * Human-readable short description of a cron expression (best effort).
 */
export function describeCron(expr: string): string {
  if (validateCron(expr) !== null) return expr;
  const fields = expr.trim().split(/\s+/);
  if (expr === '* * * * *') return 'Every minute';
  if (fields[0] === '*/1' && fields.slice(1).every(f => f === '*')) return 'Every minute';
  if (fields[0].startsWith('*/') && fields.slice(1).every(f => f === '*')) {
    return `Every ${fields[0].slice(2)} minutes`;
  }
  if (fields[0] === '0' && fields[1] === '*' && fields.slice(2).every(f => f === '*')) return 'Every hour';
  if (fields[0].startsWith('0') && fields[1].startsWith('*/') && fields.slice(2).every(f => f === '*')) {
    return `Every ${fields[1].slice(2)} hours`;
  }
  const at = `${fields[1].padStart(2, '0')}:${fields[0].padStart(2, '0')}`;
  if (fields[2] === '*' && fields[3] === '*' && fields[4] === '*') return `Daily at ${at}`;
  if (fields[2] === '*' && fields[3] === '*' && fields[4] === '1-5') return `Weekdays at ${at}`;
  if (fields[2] === '*' && fields[3] === '*' && fields[4] === '0') return `Sundays at ${at}`;
  if (fields[2] === '1' && fields[3] === '*' && fields[4] === '*') return `Monthly (1st) at ${at}`;
  return expr;
}
