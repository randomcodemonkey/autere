import { getStored, setStored } from './storage';

export type ThemeId = 'midnight' | 'gray' | 'light' | 'evergreen';

export interface ThemeOption { id: ThemeId; name: string; }

export const THEMES: ThemeOption[] = [
  { id: 'midnight', name: 'Midnight' },
  { id: 'gray', name: 'AI Gray' },
  { id: 'light', name: 'Light' },
  { id: 'evergreen', name: 'Nevergreen' },
];

export function isThemeId(v: string | null | undefined): v is ThemeId {
  return v === 'midnight' || v === 'gray' || v === 'light' || v === 'evergreen';
}

const THEME_KEY = 'autere-theme';

/** Apply a theme by stamping the documented attribute on <html>.
 *  Also remembers it per backend, so the next load paints the right theme
 *  before /auth/status answers instead of flashing another instance's. */
export function applyTheme(id: string | null | undefined) {
  if (isThemeId(id)) setStored(THEME_KEY, id);
  // midnight is the :root default (no attribute); other themes override it.
  if (!isThemeId(id) || id === 'midnight') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.setAttribute('data-theme', id);
}

/** Apply the theme this backend used last (call before the first render). */
export function applyCachedTheme() {
  applyTheme(getStored(THEME_KEY));
}

/** Theme currently in effect on <html>. */
export function activeTheme(): ThemeId {
  const attr = document.documentElement.getAttribute('data-theme');
  return isThemeId(attr) ? attr : 'midnight';
}
