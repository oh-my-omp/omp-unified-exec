/**
 * Terminal lifecycle: from the moment exec_command hands a background
 * session_id to the agent until the terminal is reclaimed.
 *
 * A terminal "returns" when its shell exits — background processes may still
 * hold the PTY — or, failing that, when its terminal closes. Then:
 *   - an abnormal return (non-zero exit, signal, failure) is reported at once;
 *     kills by the agent or a human are normal endings;
 *   - TTL after the return or the last read, the minute sweep reminds the
 *     agent: a terminal never read gets one read reminder and is kept until
 *     read; a read terminal gets a reclaim-due reminder and a grace period;
 *   - reading during the grace period starts a new TTL; otherwise the
 *     terminal's remaining processes are killed, it leaves the store, and one
 *     reclaimed notice per sweep names every terminal reclaimed in it.
 * The retained term:// and the log stay readable after reclaim. When the
 * agent's work is judged finished, `collectReturned` reclaims every returned
 * terminal at once, read or not, without notices.
 *
 * Reads are term:// reads of the returned terminal, and tool results that
 * showed it after it returned, committed when the host finalizes them.
 * Checks run once a minute: the grace period is long enough that minute
 * precision does not matter.
 */

import type { NoticeDispatcher, TerminalIdentity, TerminalNotice, TerminalOutcome } from "./terminal-notice.ts";

export const RECLAIM_TTL_MS = 30 * 60_000;
export const RECLAIM_GRACE_MS = 5 * 60_000;
export const LIFECYCLE_SWEEP_MS = 60_000;

export interface ShellExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage?: string;
}

/** The session surface the lifecycle needs (test-fakeable). */
export interface LifecycleSession {
	readonly id: number;
	readonly title: string;
	readonly displayCommand: string;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
	/** The terminal has closed. */
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage: string | null;
	/** The shell itself has exited; the terminal may still be held open. */
	readonly shellExited: boolean;
	readonly shellExit: ShellExit | undefined;
	onShellExit(listener: (exit: ShellExit) => void): () => void;
	onExit(listener: () => void): () => void;
	/** Fired for each term:// read of this terminal. */
	onTerminalRead(listener: () => void): () => void;
}

type Ending = "natural" | "killed";

type ReadState = { readonly kind: "unread" } | { readonly kind: "read"; readonly at: number };

type Phase =
	| { readonly kind: "ttl"; readonly due: number }
	| { readonly kind: "unread_reminded" }
	| { readonly kind: "grace"; readonly until: number }
	| { readonly kind: "reclaiming" };

type Life =
	| { readonly kind: "running"; readonly ending: Ending }
	| { readonly kind: "returned"; readonly outcome: TerminalOutcome; readonly returnedAt: number; readonly read: ReadState; readonly phase: Phase };

interface Tracked {
	readonly session: LifecycleSession;
	life: Life;
	readonly unsubscribe: Array<() => void>;
}
/** The lifecycle's time source and sweep scheduler; the host clock unless injected. */
export interface LifecycleClock {
	readonly nowFn?: () => number;
	readonly setIntervalFn?: (cb: () => void, ms: number) => unknown;
	readonly clearIntervalFn?: (handle: unknown) => void;
}

/** What reclaiming did: the terminal is gone (and whether processes had to be killed), or something still holds it. */
export type ReclaimResult = { readonly kind: "gone"; readonly killedProcesses: boolean } | { readonly kind: "held" };

export interface TerminalLifecycleOptions extends LifecycleClock {
	readonly notices: NoticeDispatcher;
	/** Kill what is left of the terminal's processes and remove it from the store. */
	readonly reclaim: (sessionId: number) => Promise<ReclaimResult>;
	readonly ttlMs?: number;
	readonly graceMs?: number;
	readonly sweepMs?: number;
}

export function identityOf(session: LifecycleSession): TerminalIdentity {
	return { sessionId: session.id, title: session.title, terminalUrl: session.terminalUrl, logPath: session.logPath };
}

/** Pure: how a command returned. Kills are deliberate and therefore normal. */
export function classifyReturn(exit: ShellExit, failureMessage: string | null, ending: Ending): TerminalOutcome {
	if (ending === "killed") return { kind: "normal" };
	const failure = failureMessage ?? exit.failureMessage;
	if (failure) return { kind: "abnormal", reason: `failure: ${failure}` };
	if (exit.signal) return { kind: "abnormal", reason: `signal=${exit.signal}` };
	if (exit.exitCode === null) return { kind: "abnormal", reason: "exit status unknown" };
	if (exit.exitCode !== 0) return { kind: "abnormal", reason: `exit_code=${exit.exitCode}` };
	return { kind: "normal" };
}

export class TerminalLifecycle {
	private readonly tracked = new Map<number, Tracked>();
	/** Tool results that showed a returned terminal, awaiting the host's finalization. */
	private readonly toolReads = new Map<string, Set<number>>();
	private sweeper: unknown;
	private stopped = false;
	private readonly ttlMs: number;
	private readonly graceMs: number;
	private readonly sweepMs: number;

	constructor(private readonly opts: TerminalLifecycleOptions) {
		this.ttlMs = opts.ttlMs ?? RECLAIM_TTL_MS;
		this.graceMs = opts.graceMs ?? RECLAIM_GRACE_MS;
		this.sweepMs = opts.sweepMs ?? LIFECYCLE_SWEEP_MS;
	}

	private now(): number {
		return this.opts.nowFn ? this.opts.nowFn() : Date.now();
	}

	/** Begin owning a terminal; call when exec_command commits to returning its session_id. */
	track(session: LifecycleSession): void {
		if (this.stopped || this.tracked.has(session.id)) return;
		const entry: Tracked = { session, life: { kind: "running", ending: "natural" }, unsubscribe: [] };
		this.tracked.set(session.id, entry);
		entry.unsubscribe.push(
			session.onShellExit((exit) => this.returned(entry, exit)),
			session.onExit(() => this.returned(entry, undefined)),
			session.onTerminalRead(() => this.markRead(session.id)),
		);
		if (session.shellExited || session.hasExited) this.returned(entry, session.shellExit);
		this.ensureSweeper();
	}

	isTracked(sessionId: number): boolean {
		return this.tracked.has(sessionId);
	}

	/** Lifecycle state for listings: undefined while running or untracked. */
	status(sessionId: number): { readonly outcome: TerminalOutcome; readonly read: boolean; readonly phase: Phase["kind"] } | undefined {
		const life = this.tracked.get(sessionId)?.life;
		return life?.kind === "returned" ? { outcome: life.outcome, read: life.read.kind === "read", phase: life.phase.kind } : undefined;
	}

	/** A kill is about to be sent: unless the command already returned, it ends normally. */
	noteKill(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") entry.life = { kind: "running", ending: "killed" };
	}

	/** The kill did not land: a later return is judged on its own. */
	killFailed(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") entry.life = { kind: "running", ending: "natural" };
	}

	/** A term:// read, or a committed tool result: the agent saw the returned terminal, so a new TTL starts. */
	markRead(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		// A read can race the shell-exit event; the session state is authoritative.
		if (entry.life.kind === "running" && (entry.session.shellExited || entry.session.hasExited)) this.returned(entry, entry.session.shellExit);
		const life = entry.life;
		if (life.kind !== "returned" || life.phase.kind === "reclaiming") return;
		const now = this.now();
		entry.life = { ...life, read: { kind: "read", at: now }, phase: { kind: "ttl", due: now + this.ttlMs } };
	}

	/** A tool result is about to show this terminal; it counts as a read once the host finalizes it. */
	noteToolRead(toolCallId: string, sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		if (entry.life.kind === "running" && !(entry.session.shellExited || entry.session.hasExited)) return;
		let ids = this.toolReads.get(toolCallId);
		if (!ids) this.toolReads.set(toolCallId, ids = new Set());
		ids.add(sessionId);
	}

	/** The host finalized a tool result; an error or cancellation shows the agent nothing. */
	commitToolReads(toolCallId: string, isError: boolean): void {
		const ids = this.toolReads.get(toolCallId);
		if (!ids) return;
		this.toolReads.delete(toolCallId);
		if (!isError) for (const id of ids) this.markRead(id);
	}

	/** The store evicted the terminal at its cap: that is a reclaim too. */
	evicted(session: LifecycleSession, cap: number): void {
		const entry = this.tracked.get(session.id);
		if (!entry) return;
		const outcome = entry.life.kind === "returned" ? entry.life.outcome : undefined;
		this.forget(session.id);
		void this.opts.notices.submit({
			identity: identityOf(session),
			body: { kind: "reclaimed", outcome, cause: { kind: "capacity", cap, signalled: !session.hasExited } },
		});
	}

	private forget(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		for (const unsubscribe of entry.unsubscribe) unsubscribe();
		this.tracked.delete(sessionId);
		if (this.tracked.size === 0) this.stopSweeper();
	}

	private returned(entry: Tracked, shellExit: ShellExit | undefined): void {
		if (this.stopped || entry.life.kind !== "running" || this.tracked.get(entry.session.id) !== entry) return;
		const session = entry.session;
		const exit: ShellExit = shellExit ?? session.shellExit ?? { exitCode: session.exitCode, signal: session.signal };
		const outcome = classifyReturn(exit, session.failureMessage, entry.life.ending);
		const now = this.now();
		const life: Life = { kind: "returned", outcome, returnedAt: now, read: { kind: "unread" }, phase: { kind: "ttl", due: now + this.ttlMs } };
		entry.life = life;
		if (outcome.kind === "abnormal") {
			this.submit(entry, {
				identity: identityOf(session),
				body: { kind: "abnormal_return", command: session.displayCommand, reason: outcome.reason },
			}, () => true);
		}
	}

	/** One pass over every owned terminal; the sweeper calls it once a minute. */
	sweep(): void {
		if (this.stopped) return;
		const now = this.now();
		const reclaims: Tracked[] = [];
		for (const entry of this.tracked.values()) {
			const life = entry.life;
			if (life.kind === "running") {
				// Backstop for a missed shell-exit event.
				if (entry.session.shellExited || entry.session.hasExited) this.returned(entry, entry.session.shellExit);
				continue;
			}
			const phase = life.phase;
			switch (phase.kind) {
				case "ttl": {
					if (now < phase.due) break;
					const identity = identityOf(entry.session);
					if (life.read.kind === "read") {
						const next: Life = { ...life, phase: { kind: "grace", until: now + this.graceMs } };
						entry.life = next;
						this.submit(entry, {
							identity,
							body: { kind: "reclaim_due", outcome: life.outcome, lastReadAgoMs: now - life.read.at, graceMs: this.graceMs, ttlMs: this.ttlMs },
						}, () => entry.life === next);
					} else {
						const next: Life = { ...life, phase: { kind: "unread_reminded" } };
						entry.life = next;
						this.submit(entry, { identity, body: { kind: "unread", outcome: life.outcome, returnedAgoMs: now - life.returnedAt } },
							() => entry.life === next);
					}
					break;
				}
				case "grace":
					if (now >= phase.until) reclaims.push(entry);
					break;
				case "unread_reminded":
				case "reclaiming":
					break;
			}
		}
		if (reclaims.length) void this.reclaimAll(reclaims);
		// The sweep is also a retry point for a notice whose send failed while the agent was idle.
		this.opts.notices.flush();
	}

	/** Reclaim a sweep's terminals together, so their notices share one follow-up. */
	private async reclaimAll(entries: readonly Tracked[]): Promise<void> {
		const results = await Promise.all(entries.map(async (entry): Promise<TerminalNotice | undefined> => {
			const life = entry.life;
			if (life.kind !== "returned") return undefined;
			const identity = identityOf(entry.session);
			// Still held (the kill did not land): try again at the next sweep.
			const result = await this.reclaimEntry(entry, { ...life, phase: { kind: "grace", until: this.now() } });
			if (result?.kind !== "gone") return undefined;
			return { identity, body: { kind: "reclaimed", outcome: life.outcome, cause: { kind: "grace_expired", killed: result.killedProcesses } } };
		}));
		if (this.stopped) return;
		for (const notice of results) if (notice) void this.opts.notices.submit(notice);
	}

	/**
	 * The agent is done: reclaim every returned terminal now, read or not,
	 * without notices. Running terminals and terminals already being reclaimed
	 * are left alone; a terminal something still holds keeps its prior state.
	 * Resolves to the terminals that are gone.
	 */
	async collectReturned(): Promise<ReadonlySet<number>> {
		const entries = [...this.tracked.values()].filter((entry) => entry.life.kind === "returned" && entry.life.phase.kind !== "reclaiming");
		const results = await Promise.all(entries.map(async (entry) => {
			const result = await this.reclaimEntry(entry, entry.life);
			return result?.kind === "gone" ? entry.session.id : undefined;
		}));
		return new Set(results.filter((id): id is number => id !== undefined));
	}

	/** Reclaim one returned terminal; a held one gets `onHeld`. Undefined when it changed hands meanwhile. */
	private async reclaimEntry(entry: Tracked, onHeld: Life): Promise<ReclaimResult | undefined> {
		const life = entry.life;
		if (life.kind !== "returned") return undefined;
		entry.life = { ...life, phase: { kind: "reclaiming" } };
		let result: ReclaimResult;
		try { result = await this.opts.reclaim(entry.session.id); } catch { result = { kind: "held" }; }
		if (this.tracked.get(entry.session.id) !== entry) return undefined;
		if (result.kind === "held") entry.life = onHeld;
		else this.forget(entry.session.id);
		return result;
	}

	private submit(entry: Tracked, notice: TerminalNotice, current: () => boolean): void {
		void this.opts.notices.submit(notice, () => !this.stopped && this.tracked.get(entry.session.id) === entry && current());
	}

	private ensureSweeper(): void {
		if (this.sweeper !== undefined || this.stopped) return;
		const set = this.opts.setIntervalFn ?? ((cb: () => void, ms: number) => {
			const handle = setInterval(cb, ms);
			handle.unref?.();
			return handle;
		});
		this.sweeper = set(() => this.sweep(), this.sweepMs);
	}

	private stopSweeper(): void {
		if (this.sweeper === undefined) return;
		const clear = this.opts.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
		clear(this.sweeper);
		this.sweeper = undefined;
	}

	/** Session shutdown: stop before the store kills its terminals, so those kills create no notices. */
	shutdown(): void {
		this.stopped = true;
		this.stopSweeper();
		for (const entry of this.tracked.values()) for (const unsubscribe of entry.unsubscribe) unsubscribe();
		this.tracked.clear();
		this.toolReads.clear();
	}

	/** Accept terminals again after a new session start. */
	restart(): void {
		this.stopped = false;
	}

	/** Owned terminals (test helper). */
	get size(): number {
		return this.tracked.size;
	}
}
