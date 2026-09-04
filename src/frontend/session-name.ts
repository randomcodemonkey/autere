/**
 * Client-side session naming — the ONLY place session timestamps are
 * formatted, so the user's locale and IANA timezone always apply.
 */
import { autoSessionName, type SessionStampOptions } from '../shared/format';

export function userStampOptions(): SessionStampOptions {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  return { locale: navigator.language, timeZone };
}

/** e.g. "[ui] - Sep 5, 2026, 3:12:45 PM" in the browser's locale/timezone */
export function uiSessionName(): string {
  return autoSessionName('[ui]', userStampOptions());
}
