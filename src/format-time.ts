/**
 * Shared human-readable duration formatters for TUI banners, widgets, and
 * wake metadata. Keep wall-clock math in callers; these only format ms → text.
 */

import { tr } from "./i18n.ts";

/** Widget / session lists: floored seconds → `45s`, `2m05s`, `2h40m`. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Widget/session-list duration for human-facing UI; units follow the UI language. */
export function formatElapsedUi(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return tr(`${totalSeconds}s`, `${totalSeconds}秒`);
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return tr(
		`${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`,
		`${totalMinutes}分${String(totalSeconds % 60).padStart(2, "0")}秒`,
	);
	const hours = Math.floor(totalMinutes / 60);
	return tr(
		`${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`,
		`${hours}小时${String(totalMinutes % 60).padStart(2, "0")}分`,
	);
}


/** Wake messages: rounded seconds, same shape as formatElapsed. */
export function formatElapsedShort(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Wake duration for human-facing notices; units follow the UI language. */
export function formatElapsedShortUi(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return tr(`${s}s`, `${s}秒`);
	const m = Math.floor(s / 60);
	if (m < 60) return tr(
		`${m}m${String(s % 60).padStart(2, "0")}s`,
		`${m}分${String(s % 60).padStart(2, "0")}秒`,
	);
	return tr(
		`${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`,
		`${Math.floor(m / 60)}小时${String(m % 60).padStart(2, "0")}分`,
	);
}

/** Tool result footer while running: always one decimal second (`1.2s`). */
export function formatDurationSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Current host UTC time — the trustworthy clock surfaced in tool results. */
export function nowUtcIso(nowMs: number = Date.now()): string {
	return new Date(nowMs).toISOString();
}
