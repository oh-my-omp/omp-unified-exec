/**
 * Shared human-readable duration formatters for TUI banners, widgets, and
 * wake metadata. Keep wall-clock math in callers; these only format ms → text.
 */

/** Widget / session lists: floored seconds → `45s`, `2m05s`, `2h40m`. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Wake messages: rounded seconds, same shape as formatElapsed. */
export function formatElapsedShort(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Tool result footer while running: always one decimal second (`1.2s`). */
export function formatDurationSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Current host UTC time — the trustworthy clock surfaced in tool results. */
export function nowUtcIso(nowMs: number = Date.now()): string {
	return new Date(nowMs).toISOString();
}
