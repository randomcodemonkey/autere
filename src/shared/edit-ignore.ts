/**
 * Edit-card / Edits-tab ignore matching for EDIT_IGNORE_PATHS entries.
 *
 * Entries match PATH SEGMENTS:
 * - 'pgdata'            → relative entry: matches as a contiguous segment
 *                         run at any depth ('/a/pgdata/x', 'pgdata/x')
 * - '/home/autere/pgdata' → absolute entry (leading '/'): anchored at the
 *                         path root, matches only paths under that location
 * - 'pg'                → does NOT match 'pgdata/…' (segment equality,
 *                         never substring)
 * - '.git' is always ignored at any depth, entry or not.
 *
 * extras/pi-filetools imports this exact function for chat edit cards and
 * the file-changes JSONL; the backend reuses it when reading that JSONL
 * (retroactive filtering of rows recorded before the setting existed).
 */
export function pathIsIgnored(path: string, ignoreEntries: string[]): boolean {
	const segs = path.split('/').filter(Boolean);
	if (segs.includes('.git')) return true;
	return ignoreEntries.some((dir) => {
		const parts = dir.split('/').filter(Boolean);
		if (parts.length === 0 || parts.length > segs.length) return false;
		// Absolute entry (leading '/'): anchored at the path root. Relative:
		// matches as a contiguous segment run at any depth.
		const start = dir.startsWith('/') ? 0 : -1;
		const last = start === 0 ? 1 : segs.length - parts.length + 1;
		for (let i = start; i < last; i++) {
			let ok = true;
			for (let j = 0; j < parts.length; j++) {
				if (segs[i + j] !== parts[j]) { ok = false; break; }
			}
			if (ok) return true;
		}
		return false;
	});
}
