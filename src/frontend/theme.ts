export type ThemeId = 'midnight' | 'gray' | 'light';

export interface ThemeOption { id: ThemeId; name: string; }

export const THEMES: ThemeOption[] = [
  { id: 'midnight', name: 'Midnight' },
  { id: 'gray', name: 'Gray' },
  { id: 'light', name: 'Light' },
];

export function isThemeId(v: string | null | undefined): v is ThemeId {
  return v === 'midnight' || v === 'gray' || v === 'light';
}

/** Apply a theme by stamping the documented attribute on <html>. */
export function applyTheme(id: string | null | undefined) {
  // midnight is the :root default (no attribute); other themes override it.
  if (id === 'midnight') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
}

/** Theme currently in effect on <html>. */
export function activeTheme(): ThemeId {
  const attr = document.documentElement.getAttribute('data-theme');
  return isThemeId(attr) ? attr : 'midnight';
}
