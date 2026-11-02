import { sanitizeOutputText } from "../src/output-safety.ts";
import type { TerminalSnapshot } from "../src/terminal-screen.ts";
import type { ScreenJudge } from "./screen-judge.ts";
import type { MonitorEndReason, MonitorReturns, MonitorWatch, NoticeBody, NoticeOutcome, TerminalNotice } from "./terminal-notice.ts";

export type { MonitorEndReason } from "./terminal-notice.ts";

export type MonitorStart = "accepted" | "not_running" | "cancelled";
export interface MonitorSourceHandle { cancel(): void }
export interface MonitorListener {
	/** Subscribes to rendered lines (a regex monitor), not only to output closure. */
	readonly watchesLines: boolean;
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

export type MonitorCondition =
	| { readonly kind: "end" }
	| { readonly kind: "regex"; readonly source: string; readonly regex: RegExp }
	| { readonly kind: "judge"; readonly intent: string; readonly intervalMs: number };

/** A monitor's watch as the monitor result and list_sessions report it. */
export type MonitorWatchStatus =
	| { readonly kind: "end" }
	| { readonly kind: "regex"; readonly condition: string }
	| { readonly kind: "judge"; readonly intent: string; readonly interval_ms: number };

export interface MonitorStatus {
	readonly watch: MonitorWatchStatus;
	readonly returns: number;
	readonly max_returns: number;
	readonly remind_after_ms: number;
}

export class MonitorError extends Error {
	constructor(
		readonly code:
			| "unknown_session"
			| "session_not_running"
			| "invalid_condition"
			| "invalid_judge"
			| "invalid_judge_interval_ms"
			| "judge_unavailable"
			| "invalid_max_returns"
			| "invalid_remind_after_ms"
			| "monitor_cancelled",
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "MonitorError";
	}
}

const MAX_LINE_CHARS = 1024;
const MAX_BATCH_LINES = 16;
const WINDOW_MS = 60_000;
const BATCH_MS = 250;
/** Default silence before a monitor reminds the agent that it has not returned. */
export const DEFAULT_REMIND_AFTER_MS = 20 * 60_000;
/** Default time between a judge monitor's judgments. */
export const DEFAULT_JUDGE_INTERVAL_MS = 60_000;
/** setTimeout's largest single delay. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Screen lines quoted in a reminder. */
const REMINDER_SCREEN_LINES = 8;

export interface MonitorConditionInput {
	/** JavaScript regex source. */
	readonly condition?: string;
	/** The intent a judge monitor judges each new screen against. */
	readonly judge?: string;
	readonly judgeIntervalMs?: number;
}

export function parseMonitorCondition(input: MonitorConditionInput): MonitorCondition {
	if (input.judge === undefined) {
		if (input.judgeIntervalMs !== undefined) throw new MonitorError("invalid_judge_interval_ms", "judge_interval_ms is valid only with judge");
		if (input.condition === undefined) return { kind: "end" };
		const source = input.condition;
		try { return { kind: "regex", source, regex: new RegExp(source) }; }
		catch { throw new MonitorError("invalid_condition", "condition must be a JavaScript regular expression source"); }
	}
	if (input.condition !== undefined) throw new MonitorError("invalid_judge", "judge and condition exclude each other");
	const intent = input.judge.trim();
	if (intent === "") throw new MonitorError("invalid_judge", "judge must state a nonblank intent");
	const intervalMs = input.judgeIntervalMs ?? DEFAULT_JUDGE_INTERVAL_MS;
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) {
		throw new MonitorError("invalid_judge_interval_ms", `judge_interval_ms must be an integer from 1 to ${MAX_TIMER_MS}`);
	}
	return { kind: "judge", intent, intervalMs };
}

export function parseRemindAfter(value: number | undefined): number {
	if (value === undefined) return DEFAULT_REMIND_AFTER_MS;
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
		throw new MonitorError("invalid_remind_after_ms", `remind_after_ms must be an integer from 1 to ${MAX_TIMER_MS}`);
	}
	return value;
}

/** Hands a notice to the terminal-notice dispatcher; resolves once it was delivered or dropped. */
export type MonitorSend = (notice: TerminalNotice, current: () => boolean) => Promise<NoticeOutcome>;

type MonitorBody = Extract<NoticeBody, { kind: "monitor_end" | "monitor_match" | "monitor_judge_match" | "monitor_judge_failed" | "monitor_silent" }>;

interface Batch { lines: string[]; omitted: number }

/** The screen's sanitized non-blank lines, each bounded. */
function screenLines(snapshot: TerminalSnapshot): string[] {
	return snapshot.text.split("\n").map((line) => sanitizeOutputText(line).trimEnd().slice(0, MAX_LINE_CHARS)).filter((line) => line !== "");
}

/**
 * One actual source subscription. The coordinator owns its identity and notification routing.
 *
 * Notifications leave through one serialized `flush`, which picks the most
 * informative pending event: End, then a judge failure, then matched lines or
 * a met judgment, then a due reminder. Each becomes a terminal notice; the
 * dispatcher merges and retries delivery. The reminder clock starts at
 * publication (`begin`) and restarts only when a return is delivered; a
 * delivered reminder does not re-arm it, so each silent period yields at most
 * one reminder.
 *
 * A judge monitor judges the screen one interval after publication and one
 * interval after each judgment ends. A screen equal to the last judged one
 * (or to the one shown at publication) is not judged; a judgment the agent
 * cannot get while omp has it parked waits for the next interval.
 */
export class MonitorSubscription implements MonitorListener {
	readonly watchesLines: boolean;
	private readonly watch: MonitorWatch;
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
	/** Start of the current silent period: publication or the last delivered return. */
	private silentSince = 0;
	private judgeTimer: NodeJS.Timeout | undefined;
	private judging: AbortController | undefined;
	/** The text of the screen last judged, or shown at publication. */
	private judgedScreen: string | undefined;
	/** A met screen's last lines, not yet delivered. */
	private met: readonly string[] | undefined;
	/** A failed judgment's detail, not yet delivered; the monitor ends with it. */
	private failure: string | undefined;

	constructor(
		readonly session: MonitorSession,
		private readonly condition: MonitorCondition,
		private readonly maximum: number,
		private readonly remindAfterMs: number,
		/** The judge of the agent's current session; undefined while omp has the agent parked. */
		private readonly judge: () => ScreenJudge | undefined,
		private readonly send: MonitorSend,
		private readonly finish: (subscription: MonitorSubscription, completed: boolean) => void,
		private readonly isCurrent: (subscription: MonitorSubscription) => boolean,
	) {
		this.watchesLines = condition.kind === "regex";
		switch (condition.kind) {
			case "end": this.watch = { kind: "end" }; break;
			case "regex": this.watch = { kind: "regex", condition: condition.source }; break;
			case "judge": this.watch = { kind: "judge", intent: condition.intent, intervalMs: condition.intervalMs }; break;
		}
	}

	attach(handle: MonitorSourceHandle): void { this.handle = handle; }
	status(): MonitorStatus {
		const watch: MonitorWatchStatus = this.watch.kind === "judge"
			? { kind: "judge", intent: this.watch.intent, interval_ms: this.watch.intervalMs }
			: this.watch;
		return { watch, returns: this.used, max_returns: this.maximum, remind_after_ms: this.remindAfterMs };
	}
	setEndReason(reason: MonitorEndReason): void { this.reason = reason; }

	/** Publication: the first silent period and a judge monitor's judgments start now. */
	begin(): void {
		this.startReminder();
		if (this.condition.kind !== "judge") return;
		// Only output after the call counts: the screen shown now is never judged.
		this.judgedScreen = this.session.liveSnapshot()?.text;
		this.scheduleJudgment(this.condition.intervalMs);
	}

	/** Begin a silent period; called at publication and after each delivered return. */
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

	private scheduleJudgment(intervalMs: number): void {
		if (!this.active || this.ended) return;
		this.judgeTimer = setTimeout(() => {
			this.judgeTimer = undefined;
			this.judgeScreen();
		}, intervalMs);
	}

	private judgeScreen(): void {
		const condition = this.condition;
		if (condition.kind !== "judge" || !this.active || this.ended) return;
		const snapshot = this.session.liveSnapshot();
		const judge = this.judge();
		if (snapshot === undefined || snapshot.text === this.judgedScreen || judge === undefined) {
			this.scheduleJudgment(condition.intervalMs);
			return;
		}
		const lines = screenLines(snapshot);
		const judging = new AbortController();
		this.judging = judging;
		void judge.judge(condition.intent, lines.join("\n"), judging.signal).then((verdict) => {
			// Cancel and End abort the judgment and forget it.
			if (this.judging !== judging) return;
			this.judging = undefined;
			switch (verdict.kind) {
				case "not_met":
					this.judgedScreen = snapshot.text;
					this.scheduleJudgment(condition.intervalMs);
					return;
				case "met":
					this.judgedScreen = snapshot.text;
					this.met = lines.slice(-MAX_BATCH_LINES);
					this.scheduleJudgment(condition.intervalMs);
					this.flush();
					return;
				case "failed":
					this.failure = verdict.detail;
					this.flush();
					return;
			}
		});
	}

	private stopJudging(): void {
		clearTimeout(this.judgeTimer);
		this.judgeTimer = undefined;
		this.judging?.abort();
		this.judging = undefined;
		this.met = undefined;
	}

	lines(lines: readonly string[]): void {
		if (!this.active || this.condition.kind !== "regex") return;
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
		// End is the authoritative outcome; an undelivered reminder or judgment is stale.
		this.stopReminder();
		this.stopJudging();
		this.flush();
	}

	private clearTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private returnsSoFar(): MonitorReturns {
		return { watch: this.watch, returns: this.used, maxReturns: this.maximum, remindAfterMs: this.remindAfterMs };
	}

	/** One event at a time; the dispatcher owns merging and retry, so a notice resolves only when delivered or dropped. */
	flush(): void {
		if (!this.active || !this.isCurrent(this) || this.sending) return;
		const now = Date.now();
		const monitor = this.returnsSoFar();
		let body: MonitorBody;
		if (this.ended || this.pending.lines.length) {
			this.clearTimer();
			const batch = this.pending;
			this.pending = { lines: [], omitted: 0 };
			this.pruneRecent(now);
			body = this.ended
				? { kind: "monitor_end", monitor, reason: this.reason, exitCode: this.session.exitCode, signal: this.session.signal, lines: batch.lines, omitted: batch.omitted }
				: { kind: "monitor_match", monitor, lines: batch.lines, omitted: batch.omitted, recentMatches: this.recentCount };
		} else if (this.failure !== undefined) {
			body = { kind: "monitor_judge_failed", monitor, detail: this.failure };
		} else if (this.met !== undefined) {
			body = { kind: "monitor_judge_match", monitor, screenLines: this.met };
			this.met = undefined;
		} else if (this.reminderDue) {
			body = this.silentBody(monitor, now);
		} else {
			return;
		}
		const identity = { sessionId: this.session.id, title: this.session.title, terminalUrl: this.session.terminalUrl, logPath: this.session.logPath };
		this.sending = true;
		void this.send({ identity, body }, () => this.active && this.isCurrent(this)).then((outcome) => {
			this.sending = false;
			if (outcome === "dropped" || !this.active || !this.isCurrent(this)) return;
			switch (body.kind) {
				case "monitor_end": this.finish(this, true); return;
				case "monitor_judge_failed": this.finish(this, false); return;
				case "monitor_match":
				case "monitor_judge_match":
					this.used++;
					if (this.used === this.maximum) { this.finish(this, false); return; }
					// A delivered return starts a new silent period.
					this.startReminder();
					break;
				case "monitor_silent":
					this.reminderDue = false;
					break;
			}
			if (this.pending.lines.length && !this.ended) {
				this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, BATCH_MS);
			} else {
				this.flush();
			}
		});
	}

	/** Diagnostic reminder: what the session shows now, so a blocked prompt is visible without another call. */
	private silentBody(monitor: MonitorReturns, now: number): MonitorBody {
		const snapshot = this.session.liveSnapshot();
		return {
			kind: "monitor_silent",
			monitor,
			silentMs: now - this.silentSince,
			running: !this.session.hasExited,
			lastOutputAgoMs: now - this.session.lastOutputAt,
			screen: snapshot?.view.screen ?? "unavailable",
			screenLines: snapshot ? screenLines(snapshot).slice(-REMINDER_SCREEN_LINES) : [],
		};
	}

	cancel(): void {
		this.active = false;
		this.clearTimer();
		this.stopReminder();
		this.stopJudging();
		this.handle?.cancel();
		this.pending = { lines: [], omitted: 0 };
		this.recent.length = 0;
	}
}
