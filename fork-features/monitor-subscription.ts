import { sanitizeOutputText } from "../src/output-safety.ts";
import type { TerminalSnapshot } from "../src/terminal-screen.ts";
import type { MonitorEndReason, MonitorReturns, NoticeBody, NoticeOutcome, TerminalNotice } from "./terminal-notice.ts";

export type { MonitorEndReason } from "./terminal-notice.ts";

export type MonitorStart = "accepted" | "not_running" | "cancelled";
export interface MonitorSourceHandle { cancel(): void }
export interface MonitorListener {
	readonly conditional: boolean;
	lines(lines: readonly string[]): void;
	end(): void;
}
export interface MonitorSession {
	readonly id: number;
	readonly title: string;
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
	/** Epoch ms of the last child output (spawn time before any). */
	readonly lastOutputAt: number;
	/** Current screen without consuming anything; undefined once the terminal is gone. */
	liveSnapshot(): TerminalSnapshot | undefined;
	subscribeMonitor(listener: MonitorListener, accept: (handle: MonitorSourceHandle) => boolean, signal?: AbortSignal): Promise<MonitorStart>;
}

export type MonitorCondition = { readonly kind: "end" } | { readonly kind: "regex"; readonly source: string; readonly regex: RegExp };
export interface MonitorStatus {
	readonly condition: string | null;
	readonly returns: number;
	readonly max_returns: number;
	readonly remind_after_ms: number;
}

export class MonitorError extends Error {
	constructor(readonly code: "unknown_session" | "session_not_running" | "invalid_condition" | "invalid_max_returns" | "invalid_remind_after_ms" | "monitor_cancelled", message: string) {
		super(`${code}: ${message}`);
		this.name = "MonitorError";
	}
}

export function parseMonitorCondition(source: string | undefined): MonitorCondition {
	if (source === undefined) return { kind: "end" };
	try { return { kind: "regex", source, regex: new RegExp(source) }; }
	catch { throw new MonitorError("invalid_condition", "condition must be a JavaScript regular expression source"); }
}

const MAX_LINE_CHARS = 1024;
const MAX_BATCH_LINES = 16;
const WINDOW_MS = 60_000;
const BATCH_MS = 250;
/** Default silence before a monitor reminds the agent that it has not returned. */
export const DEFAULT_REMIND_AFTER_MS = 20 * 60_000;
/** setTimeout's largest single delay. */
export const MAX_REMIND_AFTER_MS = 2_147_483_647;
/** Screen lines quoted in a reminder. */
const REMINDER_SCREEN_LINES = 8;

export function parseRemindAfter(value: number | undefined): number {
	if (value === undefined) return DEFAULT_REMIND_AFTER_MS;
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REMIND_AFTER_MS) {
		throw new MonitorError("invalid_remind_after_ms", `remind_after_ms must be an integer from 1 to ${MAX_REMIND_AFTER_MS}`);
	}
	return value;
}

/** Hands a notice to the terminal-notice dispatcher; resolves once it was delivered or dropped. */
export type MonitorSend = (notice: TerminalNotice, current: () => boolean) => Promise<NoticeOutcome>;

interface Batch { lines: string[]; omitted: number }

/**
 * One actual source subscription. The coordinator owns its identity and notification routing.
 *
 * Notifications leave through one serialized `flush`, which picks the most
 * informative pending event: End, then matched lines, then a due reminder.
 * Each becomes a terminal notice; the dispatcher merges and retries delivery.
 * The reminder clock starts at publication (`startReminder`) and restarts
 * only when a match is delivered; a delivered reminder does not re-arm it, so
 * each silent period yields at most one reminder.
 */
export class MonitorSubscription implements MonitorListener {
	readonly conditional: boolean;
	private handle: MonitorSourceHandle | undefined;
	private active = true;
	private ended = false;
	private used = 0;
	private reason: MonitorEndReason = "natural";
	private pending: Batch = { lines: [], omitted: 0 };
	private timer: NodeJS.Timeout | undefined;
	private sending = false;
	private readonly recent: Array<{ at: number; count: number }> = [];
	private recentStart = 0;
	private recentCount = 0;
	private reminder: NodeJS.Timeout | undefined;
	private reminderDue = false;
	/** Start of the current silent period: publication or the last delivered match. */
	private silentSince = 0;

	constructor(
		readonly session: MonitorSession,
		private readonly condition: MonitorCondition,
		private readonly maximum: number,
		private readonly remindAfterMs: number,
		private readonly send: MonitorSend,
		private readonly finish: (subscription: MonitorSubscription, completed: boolean) => void,
		private readonly isCurrent: (subscription: MonitorSubscription) => boolean,
	) {
		this.conditional = condition.kind === "regex";
	}

	attach(handle: MonitorSourceHandle): void { this.handle = handle; }
	status(): MonitorStatus {
		return { condition: this.condition.kind === "regex" ? this.condition.source : null, returns: this.used, max_returns: this.maximum, remind_after_ms: this.remindAfterMs };
	}
	setEndReason(reason: MonitorEndReason): void { this.reason = reason; }

	/** Begin a silent period; called when the subscription is published and after each delivered match. */
	startReminder(): void {
		clearTimeout(this.reminder);
		this.reminderDue = false;
		if (!this.active || this.ended) return;
		this.silentSince = Date.now();
		this.reminder = setTimeout(() => {
			this.reminder = undefined;
			this.reminderDue = true;
			this.flush();
		}, this.remindAfterMs);
	}

	private stopReminder(): void {
		clearTimeout(this.reminder);
		this.reminder = undefined;
		this.reminderDue = false;
	}

	lines(lines: readonly string[]): void {
		if (!this.active || this.condition.kind === "end") return;
		for (const raw of lines) {
			const line = sanitizeOutputText(raw).slice(0, MAX_LINE_CHARS);
			if (!this.condition.regex.test(line)) continue;
			const now = Date.now();
			const last = this.recent[this.recent.length - 1];
			if (last?.at === now) last.count++;
			else this.recent.push({ at: now, count: 1 });
			this.recentCount++;
			this.pruneRecent(now);
			if (this.pending.lines.length < MAX_BATCH_LINES) this.pending.lines.push(line);
			else this.pending.omitted++;
		}
		if (this.pending.lines.length && this.timer === undefined && !this.ended) {
			this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, BATCH_MS);
		}
	}

	private pruneRecent(now: number): void {
		while (this.recentStart < this.recent.length && this.recent[this.recentStart]!.at <= now - WINDOW_MS) {
			this.recentCount -= this.recent[this.recentStart++]!.count;
		}
		if (this.recentStart > 1024 && this.recentStart * 2 > this.recent.length) {
			this.recent.splice(0, this.recentStart);
			this.recentStart = 0;
		}
	}

	end(): void {
		if (!this.active || this.ended) return;
		this.ended = true;
		this.clearTimer();
		// End is the authoritative outcome; an undelivered reminder is stale.
		this.stopReminder();
		this.flush();
	}

	private clearTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private returnsSoFar(): MonitorReturns {
		return { condition: this.condition.kind === "regex" ? this.condition.source : null, returns: this.used, maxReturns: this.maximum, remindAfterMs: this.remindAfterMs };
	}

	/** One event at a time; the dispatcher owns merging and retry, so a notice resolves only when delivered or dropped. */
	flush(): void {
		if (!this.active || !this.isCurrent(this) || this.sending) return;
		const event = this.ended ? "end" : this.pending.lines.length ? "match" : this.reminderDue ? "silent" : undefined;
		if (!event) return;
		this.clearTimer();
		const batch = this.pending;
		this.pending = { lines: [], omitted: 0 };
		const now = Date.now();
		this.pruneRecent(now);
		const monitor = this.returnsSoFar();
		const body: NoticeBody = event === "end"
			? { kind: "monitor_end", monitor, reason: this.reason, exitCode: this.session.exitCode, signal: this.session.signal, lines: batch.lines, omitted: batch.omitted }
			: event === "match"
				? { kind: "monitor_match", monitor, lines: batch.lines, omitted: batch.omitted, recentMatches: this.recentCount }
				: this.silentBody(monitor, now);
		const identity = { sessionId: this.session.id, title: this.session.title, terminalUrl: this.session.terminalUrl, logPath: this.session.logPath };
		this.sending = true;
		void this.send({ identity, body }, () => this.active && this.isCurrent(this)).then((outcome) => {
			this.sending = false;
			if (outcome === "dropped" || !this.active || !this.isCurrent(this)) return;
			if (event === "end") { this.finish(this, true); return; }
			if (event === "match") {
				this.used++;
				if (this.used === this.maximum) { this.finish(this, false); return; }
				// A delivered match is a return: a new silent period begins.
				this.startReminder();
			} else {
				this.reminderDue = false;
			}
			if (this.ended) this.flush();
			else if (this.pending.lines.length && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, BATCH_MS);
		});
	}

	/** Diagnostic reminder: what the session shows now, so a blocked prompt is visible without another call. */
	private silentBody(monitor: MonitorReturns, now: number): NoticeBody {
		const snapshot = this.session.liveSnapshot();
		const screen = snapshot ? snapshot.text.split("\n").map((line) => sanitizeOutputText(line).trimEnd().slice(0, MAX_LINE_CHARS)).filter((line) => line !== "") : [];
		return {
			kind: "monitor_silent",
			monitor,
			silentMs: now - this.silentSince,
			running: !this.session.hasExited,
			lastOutputAgoMs: now - this.session.lastOutputAt,
			screen: snapshot?.view.screen ?? "unavailable",
			screenLines: screen.slice(-REMINDER_SCREEN_LINES),
		};
	}

	cancel(): void {
		this.active = false;
		this.clearTimer();
		this.stopReminder();
		this.handle?.cancel();
		this.pending = { lines: [], omitted: 0 };
		this.recent.length = 0;
	}
}
