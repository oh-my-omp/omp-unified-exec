import type { InputWaitAlert } from "../fork-features/input-wait.ts";
import { MonitorError, MonitorSubscription, parseMonitorCondition, parseRemindAfter, type MonitorEndReason, type MonitorSession, type MonitorStatus } from "../fork-features/monitor-subscription.ts";
import type { NoticeDispatcher, TerminalNotice } from "../fork-features/terminal-notice.ts";

/**
 * CompletionCoordinator — agent-level completion scheduling for
 * `exec_command(on_exit: "wake")`, kept deliberately separate from the
 * low-level ExecSession process transport.
 *
 * The central exactly-once invariant:
 *
 *     Terminal completion is delivered through a finalized tool result
 *                              OR
 *     terminal completion causes one synthetic model prompt,
 *                   normally never both.
 *
 * How the invariant is enforced:
 *   - A record is only created ("armed") once exec_command has committed to
 *     returning a background session_id.
 *   - Any write_stdin call that could return terminal status takes an
 *     OBSERVATION LEASE (keyed by toolCallId). While at least one observer is
 *     active, process exit is recorded but a wake is never enqueued.
 *   - "Observed" is committed at Pi's finalized tool-result event
 *     (`tool_execution_end` with isError=false), NOT merely when the handler
 *     returns — a result that was constructed but finalized as error/cancelled
 *     keeps the completion wake-eligible.
 *   - Wake records are RESERVED (wakeQueued=true) before they are handed to
 *     the terminal-notice dispatcher, so concurrent flush triggers can never
 *     double-submit; the dispatcher drops a wake that is observed or
 *     suppressed before it is sent, and retries a failed send.
 *   - Kill paths suppress the wake BEFORE signaling the process; a failed kill
 *     restores the prior eligibility.
 */

export type OnExitPolicy = "none" | "wake";

/** Minimal session surface the coordinator needs (test-fakeable). */
export interface CompletionSessionLike {
	readonly id: number;
	readonly title: string;
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly logPath: string | undefined;
	readonly terminalUrl?: string;
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage: string | null;
	onExit(listener: (session: unknown) => void): () => void;
}

/** Bounded completion metadata captured at exit time. */
export interface CompletionSnapshot {
	sessionId: number;
	title: string;
	command: string;
	cwd: string;
	startedAtMs: number;
	elapsedMs: number;
	exitCode: number | null;
	signal: string | null;
	failureMessage: string | null;
	logPath: string | undefined;
	terminalUrl?: string;
}

interface CompletionRecord {
	sessionId: number;
	armed: boolean;
	exited: boolean;
	observed: boolean;
	suppressed: boolean;
	wakeQueued: boolean;
	/** toolCallIds of active observation leases. */
	observers: Set<string>;
	/** toolCallIds that returned a terminal result awaiting finalization. */
	pendingTerminal: Set<string>;
	snapshot: CompletionSnapshot | undefined;
	session: CompletionSessionLike;
	unsubscribeExit: () => void;
}


export interface CompletionCoordinatorOptions {
	/** The one delivery path for terminal notices: wakes, monitor returns and input-wait alerts. */
	notices: NoticeDispatcher;
	/** Debounce so naturally simultaneous completions are submitted together. */
	debounceMs?: number;
	/** Injectable timers. Test hooks. */
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	nowFn?: () => number;
}

/** Validated by `startMonitor`; omitted fields take the monitor defaults. */
export interface MonitorOptions {
	/** JavaScript regex source; omitted waits for output closure only. */
	condition?: string;
	maxReturns?: number;
	/** Silence before a one-time reminder that the monitor has not returned (default 20 minutes). */
	remindAfterMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 250;

/** Strip terminal control characters from untrusted interpolated strings. */
export function sanitizeMeta(raw: string): string {
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class CompletionCoordinator {
	private readonly records = new Map<number, CompletionRecord>();
	private monitors = new Map<number, MonitorSubscription>();
	private readonly opts: Required<Pick<CompletionCoordinatorOptions, "notices" | "debounceMs">> & CompletionCoordinatorOptions;
	private debounceHandle: unknown;
	private stopped = false;

	constructor(options: CompletionCoordinatorOptions) {
		this.opts = { debounceMs: DEFAULT_DEBOUNCE_MS, ...options };
	}

	private now(): number {
		return this.opts.nowFn ? this.opts.nowFn() : Date.now();
	}

	private setTimer(cb: () => void, ms: number): unknown {
		return this.opts.setTimeoutFn ? this.opts.setTimeoutFn(cb, ms) : setTimeout(cb, ms);
	}

	private clearTimer(handle: unknown): void {
		if (this.opts.clearTimeoutFn) this.opts.clearTimeoutFn(handle);
		else clearTimeout(handle as NodeJS.Timeout);
	}

	/** Number of live records (test helper). */
	get recordCount(): number {
		return this.records.size;
	}

	async startMonitor(session: MonitorSession, options: MonitorOptions = {}, signal?: AbortSignal): Promise<MonitorStatus> {
		const condition = parseMonitorCondition(options.condition);
		const maximum = options.maxReturns ?? 10;
		if (!Number.isSafeInteger(maximum) || maximum < 1) throw new MonitorError("invalid_max_returns", "max_returns must be a positive safe integer");
		const remindAfterMs = parseRemindAfter(options.remindAfterMs);
		const notices = this.opts.notices;
		const send = (notice: TerminalNotice, isCurrent: () => boolean) => notices.submit(notice, isCurrent);
		const scope = this.monitors;
		const current = (subscription: MonitorSubscription): boolean => !this.stopped && this.monitors === scope && scope.get(session.id) === subscription;
		const subscription = new MonitorSubscription(session, condition, maximum, remindAfterMs, send,
			(sub, completed) => {
				if (!current(sub)) return;
				// Consume the ordinary wake before removing monitor ownership.
				if (completed) {
					const record = this.records.get(session.id);
					if (record) this.resolveRecord(record);
				}
				scope.delete(session.id);
				sub.cancel();
				this.scheduleFlush();
			},
			current);
		const result = await session.subscribeMonitor(subscription, (handle) => {
			if (this.stopped || this.monitors !== scope || signal?.aborted) return false;
			subscription.attach(handle);
			const old = scope.get(session.id);
			scope.set(session.id, subscription);
			old?.cancel();
			// The silent period starts with publication, not with the tool result.
			subscription.startReminder();
			return true;
		}, signal);
		if (result !== "accepted") {
			subscription.cancel();
			throw new MonitorError(result === "not_running" ? "session_not_running" : "monitor_cancelled",
				result === "not_running" ? "session is no longer running" : "monitor establishment was cancelled");
		}
		if (signal?.aborted) {
			if (current(subscription)) {
				scope.delete(session.id);
				this.scheduleFlush();
			}
			subscription.cancel();
			throw new MonitorError("monitor_cancelled", "monitor establishment was cancelled");
		}
		return subscription.status();
	}

	monitorStatus(sessionId: number): MonitorStatus | undefined { return this.monitors.get(sessionId)?.status(); }

	cancelMonitor(sessionId: number): boolean {
		const subscription = this.monitors.get(sessionId);
		if (!subscription) return false;
		this.monitors.delete(sessionId);
		subscription.cancel();
		this.scheduleFlush();
		return true;
	}

	monitorEndReason(sessionId: number, reason: MonitorEndReason): void {
		this.monitors.get(sessionId)?.setEndReason(reason);
	}

	/**
	 * Deliver an input-wait alert. The dispatcher keeps only the newest alert
	 * per session and drops it once it no longer describes the current, unseen screen.
	 */
	alertInputWait(alert: InputWaitAlert): void {
		if (this.stopped) return;
		void this.opts.notices.submit(alert.notice, () => !this.stopped && alert.current());
	}

	/**
	 * Arm `on_exit: "wake"` for a session. Call ONLY once exec_command has
	 * committed to returning a background session_id. Handles the boundary
	 * race: if the process already exited (or exits immediately after), the
	 * exit listener fires and the completion is still delivered exactly once.
	 */
	register(session: CompletionSessionLike): void {
		if (this.stopped) return;
		if (this.records.has(session.id)) return;
		const record: CompletionRecord = {
			sessionId: session.id,
			armed: true,
			exited: false,
			observed: false,
			suppressed: false,
			wakeQueued: false,
			observers: new Set(),
			pendingTerminal: new Set(),
			snapshot: undefined,
			session,
			unsubscribeExit: () => {},
		};
		this.records.set(session.id, record);
		// ExecSession.onExit fires (via microtask) even if the session already
		// exited, so the register-vs-exit race cannot lose the completion.
		record.unsubscribeExit = session.onExit(() => this.recordExit(record));
	}

	/** Whether a wake is currently armed (and not yet resolved) for a session. */
	isArmed(sessionId: number): boolean {
		const r = this.records.get(sessionId);
		return !!r && r.armed && !r.observed && !r.suppressed;
	}

	/**
	 * Change on_exit policy by session id.
	 *   - "none": disarm any pending wake record (including LRU tombstones that
	 *     no longer have a store session). Does not kill the process.
	 *   - "wake": arm auto-resume; requires a still-running `session` object.
	 *
	 * Disarm cannot recall a follow-up that `send` has already handed to pi.
	 */
	setOnExit(
		sessionId: number,
		policy: OnExitPolicy,
		session?: CompletionSessionLike | null,
	): "disarmed" | "already_none" | "armed" | "already_armed" | "too_late" {
		if (this.stopped) return policy === "wake" ? "too_late" : "already_none";
		const existing = this.records.get(sessionId);

		if (policy === "none") {
			if (!existing) return "already_none";
			// Suppress even if a flush already reserved the wake but has not
			// resolved the record yet — resolve drops it so flushPending skips it.
			existing.suppressed = true;
			this.resolveRecord(existing);
			return "disarmed";
		}

		// policy === "wake"
		if (existing) {
			if (existing.observed || existing.suppressed) return "too_late";
			return "already_armed";
		}
		if (!session || session.id !== sessionId || session.hasExited) return "too_late";
		this.register(session);
		return "armed";
	}

	private recordExit(record: CompletionRecord): void {
		// Repeated exit callbacks must never create duplicate wakes: the exited
		// flag latches and the snapshot is captured once.
		if (record.exited) return;
		record.exited = true;
		const s = record.session;
		record.snapshot = {
			sessionId: s.id,
			title: s.title,
			command: s.displayCommand,
			cwd: s.cwd,
			startedAtMs: s.startedAt,
			elapsedMs: this.now() - s.startedAt,
			exitCode: s.exitCode,
			signal: s.signal,
			failureMessage: s.failureMessage,
			logPath: s.logPath,
			terminalUrl: s.terminalUrl,
		};
		this.scheduleFlush();
	}

	// ---------------- Observation leases ----------------

	/**
	 * A write_stdin call that may return terminal status becomes an observer.
	 * While any observer is active, exit is recorded but no wake is enqueued.
	 */
	beginObservation(sessionId: number, toolCallId: string): void {
		this.records.get(sessionId)?.observers.add(toolCallId);
	}

	/**
	 * Release an observer WITHOUT marking completion observed (attachment
	 * window ended while still running, cancellation or handler error).
	 * The wake stays armed.
	 */
	releaseObservation(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.delete(toolCallId);
		r.pendingTerminal.delete(toolCallId);
		if (r.exited) this.scheduleFlush();
	}

	/**
	 * The handler constructed a terminal result for this tool call. The
	 * observation lease is HELD until Pi finalizes the tool result
	 * (`tool_execution_end`), at which point the completion is either marked
	 * observed (success) or released back to wake eligibility (error/cancel).
	 */
	markPendingTerminal(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.add(toolCallId);
		r.pendingTerminal.add(toolCallId);
	}

	/**
	 * Pi finalized a tool result. Commits "observed" for pending-terminal
	 * observations on success; releases the lease (keeping the wake eligible)
	 * on error/cancellation. Also cleans up any stale lease for this call ID.
	 */
	handleToolExecutionEnd(toolCallId: string, isError: boolean): void {
		for (const r of this.records.values()) {
			if (r.pendingTerminal.has(toolCallId)) {
				r.pendingTerminal.delete(toolCallId);
				r.observers.delete(toolCallId);
				if (!isError) {
					this.commitObserved(r);
				} else if (r.exited) {
					this.scheduleFlush();
				}
			} else if (r.observers.has(toolCallId)) {
				// Handler failed/cancelled before releasing: clean up the lease.
				r.observers.delete(toolCallId);
				if (r.exited) this.scheduleFlush();
			}
		}
		// Any tool boundary is also a safe point to retry failed sends.
		this.flushPending();
	}

	private commitObserved(record: CompletionRecord): void {
		record.observed = true;
		this.resolveRecord(record);
	}

	/**
	 * list_sessions (or another status read) reported terminal completion:
	 * that report counts as direct observation and suppresses the wake. A wake
	 * still pending in the dispatcher is dropped; one already sent stays sent.
	 */
	observeViaListing(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		this.commitObserved(r);
	}

	// ---------------- Kill / eviction / shutdown suppression ----------------

	/** Suppress the wake BEFORE signaling the process on an explicit kill. */
	suppress(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (r) r.suppressed = true;
	}

	/** The kill landed; the record is finished. */
	confirmKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (r) this.resolveRecord(r);
	}

	/** The kill did NOT land and the process is still alive: restore eligibility. */
	restoreAfterFailedKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.suppressed = false;
		if (r.exited) this.scheduleFlush();
	}

	/**
	 * A session was evicted from the store.
	 *   - Live process (LRU terminating it): suppress the wake.
	 *   - Naturally exited before notification: keep a bounded tombstone
	 *     snapshot long enough to send the one wake (the log path survives in
	 *     the snapshot even though the session can no longer be drained).
	 */
	handleEviction(session: CompletionSessionLike): void {
		const r = this.records.get(session.id);
		if (!r) return;
		if (!session.hasExited) {
			// Being terminated by the eviction — not a natural completion.
			r.suppressed = true;
			this.resolveRecord(r);
			return;
		}
		// Natural exit, not yet notified: the record (with snapshot) IS the
		// tombstone; the flush will deliver exactly one wake.
		this.scheduleFlush();
	}

	/** Session shutdown / reset / teardown: cancel timers, drop all records. */
	shutdown(): void {
		this.stopped = true;
		const monitors = this.monitors;
		this.monitors = new Map();
		for (const subscription of monitors.values()) subscription.cancel();
		monitors.clear();
		if (this.debounceHandle !== undefined) {
			this.clearTimer(this.debounceHandle);
			this.debounceHandle = undefined;
		}
		for (const r of this.records.values()) {
			r.unsubscribeExit();
		}
		this.records.clear();
	}

	/** Re-arm after a new session_start (never resurrects old records). */
	reset(): void {
		this.shutdown();
		this.stopped = false;
	}

	private resolveRecord(record: CompletionRecord): void {
		if (this.records.get(record.sessionId) !== record) return;
		record.unsubscribeExit();
		this.records.delete(record.sessionId);
	}

	// ---------------- Wake delivery ----------------

	private scheduleFlush(): void {
		if (this.stopped) return;
		if (this.debounceHandle !== undefined) return;
		this.debounceHandle = this.setTimer(() => {
			this.debounceHandle = undefined;
			this.flushPending();
		}, this.opts.debounceMs);
	}

	/**
	 * Submit pending wakes, then flush the dispatcher. Safe to call from any
	 * flush trigger (debounce timer, a settled run's agent_end, tool_execution_end), which
	 * are also the dispatcher's retry points for a failed send; reservation via
	 * wakeQueued guarantees at most one submission per completion.
	 */
	flushPending(): void {
		if (this.stopped) return;
		for (const r of this.records.values()) {
			if (
				r.armed &&
				r.exited &&
				!r.observed &&
				!r.suppressed &&
				!r.wakeQueued &&
				!this.monitors.has(r.sessionId) &&
				r.observers.size === 0 &&
				r.snapshot
			) {
				this.submitWake(r, r.snapshot);
			}
		}
		this.opts.notices.flush();
	}

	private submitWake(record: CompletionRecord, s: CompletionSnapshot): void {
		// Reserve BEFORE submitting so a re-entrant flush cannot double-submit.
		record.wakeQueued = true;
		const live = () => !this.stopped && this.records.get(record.sessionId) === record && !record.observed && !record.suppressed;
		void this.opts.notices.submit({
			identity: { sessionId: s.sessionId, title: s.title, terminalUrl: s.terminalUrl, logPath: s.logPath },
			body: { kind: "exit_wake", command: s.command, cwd: s.cwd, elapsedMs: s.elapsedMs, exitCode: s.exitCode, signal: s.signal, failure: s.failureMessage },
		}, live).then((outcome) => {
			if (this.records.get(record.sessionId) !== record) return;
			if (outcome === "delivered") this.resolveRecord(record);
			else record.wakeQueued = false;
		});
	}
}
