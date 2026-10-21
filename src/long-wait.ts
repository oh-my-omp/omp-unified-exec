/**
 * Event-driven wait for session collection, shutdown and kill confirmation.
 *
 *   - listens ONLY on process exit, external cancellation, and one timer;
 *   - never consumes process output (the session's terminal screen keeps
 *     rendering and the log file keeps receiving every byte);
 *   - runs on a MONOTONIC clock: the wall-clock deadline is converted once
 *     into a duration by the caller, then anchored to `performance.now()`
 *     here, so a later NTP adjustment or manual system-clock change cannot
 *     lengthen or shorten an in-progress wait.
 */

export type LongWaitOutcome = "exit" | "deadline" | "cancelled";

/**
 * Max single setTimeout arm. Longer durations re-arm in chunks to avoid
 * overflowing the platform timer.
 */
export const MAX_TIMER_ARM_MS = 2_147_483_647; // 2^31 - 1

export interface LongWaitInputs {
	/** Aborts when the process has exited. */
	exited: AbortSignal;
	/** External cancellation (Esc / tool-call abort). Never kills the child. */
	externalAbort?: AbortSignal;
	/** Validated duration in ms; absolute callers compute it once from wall time. */
	durationMs: number;
	/** Injectable monotonic clock (default: performance.now). Test hook. */
	monotonicNow?: () => number;
	/** Injectable timer functions. Test hooks. */
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Wait until the process exits, the tool call is cancelled, or the monotonic
 * deadline arrives — whichever happens first. All timers and listeners are
 * released on every exit path.
 */
export async function waitForExitOrDeadline(inputs: LongWaitInputs): Promise<LongWaitOutcome> {
	const { exited, externalAbort, durationMs } = inputs;
	const monotonicNow = inputs.monotonicNow ?? (() => performance.now());
	const setTimeoutFn = inputs.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
	const clearTimeoutFn = inputs.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

	if (!Number.isFinite(durationMs) || Math.abs(durationMs) > Number.MAX_SAFE_INTEGER) {
		throw new Error("Wait duration must be finite and within the safe millisecond range.");
	}
	if (exited.aborted) return "exit";
	if (externalAbort?.aborted) return "cancelled";
	if (durationMs <= 0) return "deadline";

	// Subtract elapsed time rather than adding a possibly enormous duration
	// to the clock. This accepts the full safe millisecond range without an
	// overflowing or imprecise absolute deadline. Never consult wall time.
	const startedAt = monotonicNow();
	const remainingMs = () => durationMs - (monotonicNow() - startedAt);

	const cleanups: Array<() => void> = [];
	try {
		const exitP = new Promise<LongWaitOutcome>((resolve) => {
			const onAbort = () => resolve("exit");
			exited.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => exited.removeEventListener("abort", onAbort));
		});
		const cancelP: Promise<LongWaitOutcome> = externalAbort
			? new Promise((resolve) => {
					const onAbort = () => resolve("cancelled");
					externalAbort.addEventListener("abort", onAbort, { once: true });
					cleanups.push(() => externalAbort.removeEventListener("abort", onAbort));
				})
			: new Promise<never>(() => {});

		// Single timer, re-armed only if it fires before the monotonic deadline
		// (coarse timer granularity, or multi-day waits chunked below the
		// setTimeout overflow ceiling). No polling loop, no per-chunk wakeups.
		let timerHandle: unknown;
		cleanups.push(() => {
			if (timerHandle !== undefined) clearTimeoutFn(timerHandle);
		});
		const armTimer = (): Promise<void> =>
			new Promise<void>((resolve) => {
				const remaining = Math.max(1, remainingMs());
				const armMs = Math.min(remaining, MAX_TIMER_ARM_MS);
				timerHandle = setTimeoutFn(() => {
					timerHandle = undefined;
					resolve();
				}, armMs);
			});

		for (;;) {
			const which = await Promise.race([exitP, cancelP, armTimer().then(() => "timer" as const)]);
			if (which === "exit" || which === "cancelled") return which;
			// Timer fired: trust only the monotonic clock.
			if (remainingMs() <= 0) return "deadline";
			if (timerHandle !== undefined) {
				clearTimeoutFn(timerHandle);
				timerHandle = undefined;
			}
		}
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}
