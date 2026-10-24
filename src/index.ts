/**
 * unified-exec — omp extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM (the host's `bash` stays active for short one-shot
 * commands):
 *   - exec_command(cmd, workdir?, shell?, cols?, rows?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, chars_b64?, yield_time_ms?)
 *   - set_on_exit(session_id, on_exit)            [disarm/re-arm wake without kill]
 *   - monitor(session_id, condition?, …)         [future-output wakes]
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session in a PTY with no command
 *     deadline. If the process is still alive when the call's yield deadline
 *     expires, the tool returns with `session_id` in its body and the LLM can
 *     read terminal_url, subscribe with monitor, or send input with write_stdin.
 *   - `write_stdin` requires nonempty decoded input and writes bytes verbatim
 *     to the PTY (\\x03 is Ctrl-C to the foreground process group; nothing
 *     such as a trailing \\r is appended).
 *   - Results report the session's rendered terminal screen, so every read
 *     is bounded by the screen size.
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Sessions are terminated on session_shutdown (codex parity); a process
 *     that exits is never restarted.
 *   - Every byte the child writes goes to a per-session log file at
 *     /tmp/pi-unified-exec-<sid>-<random>.log. The LLM sees the rendered
 *     screen (capped at ~50 KiB / 2000 lines); the raw stream stays in the log.
 */

import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import { type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { approvalCommand, approveBoundCommand, type CommandApprovalHost } from "../fork-features/command-approval.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "../fork-features/session-binding.ts";
import { MonitorError } from "../fork-features/monitor-subscription.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed, nowUtcIso } from "./format-time.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { DEFAULT_PTY_ROWS } from "./pty.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResult,
	listSessionsScriptResultSchema,
	monitorScriptResultSchema,
	type MonitorScriptResult,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResult,
	setOnExitScriptResultSchema,
} from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { buildShellCommand, IS_WINDOWS, resolveBinary, resolveDefaultShell, resolveWindowsShell } from "./shell.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	terminalViewDetails,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
// session_shutdown waits this long for SIGTERM to land, then SIGKILLs survivors
// and waits SHUTDOWN_KILL_GRACE_MS for confirmation.
const SHUTDOWN_TERM_GRACE_MS = 1000;
const SHUTDOWN_KILL_GRACE_MS = 500;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input streaming updates
// A screen that stays this quiet is examined for an unseen input prompt.
const INPUT_WAIT_QUIET_MS = 5_000;
// PTY dimension clamps for exec_command's cols/rows.
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
const SESSION_UI_KEY = "unified-exec.sessions";

/**
 * Google-compatible string enum schema (plain `type: "string"` + `enum`,
 * mirroring pi-ai's StringEnum helper) — a TypeBox literal union (anyOf/const)
 * breaks Google models.
 */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textEncoder = new TextEncoder();

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	warnedShellFallback: boolean;
	notifiedBashSource: boolean;
	/**
	 * Sessions spawned but not yet inserted into the store (inside the
	 * early-exit grace window). Membership is ownership: session_shutdown
	 * terminates these and removes them, so an exec_command whose session is
	 * no longer here after the grace must not insert it into the store.
	 */
	pendingSessions: Set<ExecSession>;
	/** Set on session_shutdown; new exec_commands are rejected. */
	shuttingDown: boolean;
	/** The host's light/dark appearance, which sessions answer to OSC 10/11. */
	appearance: () => TerminalAppearance;
	/** Live omp-owned setting. Called for each new process. */
	shellPath?: () => string | undefined;
	/** omp's shared GitHub view-cache invalidation for `gh` mutations, as the host bash calls it. */
	invalidateGithubCache?: (command: string) => void;
}

type ExecCommandArgs = {
	cmd: string;
	workdir?: string;
	shell?: string;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_b64?: string;
	yield_time_ms?: number;
};

/** The write surface does not observe a session without sending input. */
export class EmptyPollRemovedError extends Error {
	readonly code = "empty_poll_removed";

	constructor(terminalUrl: string | undefined) {
		super(`empty_poll_removed: write_stdin requires input bytes. Read state and content with read ${terminalUrl ?? "term://<key>"}; wait for output events or completion with monitor.`);
		this.name = "EmptyPollRemovedError";
	}
}

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

const HELD_OPEN_NOTE =
	"shell has exited, but background process(es) still hold the terminal " +
	"(e.g. a nohup'd or SIGHUP-ignoring job that kept the PTY as stdin/stdout/stderr), " +
	"so this session stays open until they exit. To detach: redirect inside the job — " +
	"`setsid cmd >log 2>&1 </dev/null &` — or end the session with kill_session.";

/**
 * Explanation for sessions whose shell has exited but whose terminal is
 * still held open by background processes: they report "running" even though
 * the foreground command is long done. State-driven (never command-text
 * matching), so it covers any construct that leaves a terminal holder behind.
 */
function heldOpenNote(session: ExecSession): string | undefined {
	return session.shellExited && !session.hasExited ? HELD_OPEN_NOTE : undefined;
}

/** The host bash's working-directory error for `dir`, or undefined when it is a usable directory. */
function workdirProblem(dir: string): string | undefined {
	try {
		return statSync(dir).isDirectory() ? undefined : `Working directory is not a directory: ${dir}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return `Working directory does not exist: ${dir}`;
		throw error;
	}
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	cwd: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "exec_command" });
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell(undefined, ctx.shellPath?.());
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				"unified-exec: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_UNIFIED_EXEC_BASH.",
				"warning",
			);
		} else if (
			!resolved.fellBack &&
			resolved.bashSource &&
			resolved.bashSource !== "path" &&
			resolved.bashSource !== "env" &&
			!ctx.notifiedBashSource
		) {
			// bash located off PATH (derived from git.exe or a known install
			// root) — say so once, so shell selection is never mysterious.
			ctx.notifiedBashSource = true;
			ctx.ui?.notify(`unified-exec: using bash at ${resolved.shell} (not on PATH)`, "info");
		}
	}
	// A relative workdir is relative to the calling session's cwd, never to the host process's.
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? resolve(cwd, args.workdir) : cwd;
	// Resolve before building argv so the result names exactly what is spawned.
	// Windows resolution fails closed to avoid cwd-first executable lookup.
	shellBin = /[\\/]/.test(shellBin)
		? resolve(effectiveCwd, shellBin)
		: IS_WINDOWS ? resolveWindowsShell(shellBin) : resolveBinary(shellBin);
	const shellCommand = buildShellCommand(shellBin, args.cmd);
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
	const wantsWake = args.on_exit === "wake";

	// Same wording as the host's bash; nothing is spawned for an unusable directory.
	const workdirFailure = workdirProblem(effectiveCwd);
	if (workdirFailure) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: NO_OUTPUT,
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: workdirFailure,
			logPath: undefined,
			cwd: effectiveCwd,
			shell: shellBin,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Like the host bash: a `gh` mutation clears issue:// / pr:// cache rows
	// before it runs; a failed command still pays only one extra fetch.
	ctx.invalidateGithubCache?.(args.cmd);

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command: shellCommand.command,
		cwd: effectiveCwd,
		env: process.env,
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: args.cmd,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
		appearance: ctx.appearance,
		inputWait: { quietMs: INPUT_WAIT_QUIET_MS, onAlert: (alert) => ctx.coordinator.alertInputWait(alert) },
	});

	if (session.failureMessage) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: NO_OUTPUT,
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			shell: session.shell,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Track the session from spawn to store-insertion: session_shutdown must
	// be able to terminate children that are still inside the grace window.
	ctx.pendingSessions.add(session);
	try {
		// Early-exit grace: if the process dies within 150 ms, treat it as a
		// short-lived command and never register it.
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			// Fully short-lived: return the final screen once the output has
			// closed (the log is flushed and the terminal frozen).
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					// Exit delivered in this very result: a requested wake is
					// satisfied directly without ever being armed.
					...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				},
			});
		}
		// session_shutdown inside the grace took ownership of the session and is
		// terminating it: the session belongs to an ended session period, so it
		// never enters the store and the call reports the process's actual end.
		if (!ctx.pendingSessions.has(session)) {
			await waitForExitOrDeadline({ exited: session.exited, durationMs: SHUTDOWN_TERM_GRACE_MS + SHUTDOWN_KILL_GRACE_MS });
			const exited = session.hasExited;
			const collected = exited ? await session.collect({ deadlineMs: Date.now() + 500 }) : NO_OUTPUT;
			return finalizeResponse({
				wallTimeSec: (Date.now() - start) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: exited ? session.failureMessage : "terminated by session_shutdown; exit not confirmed",
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				// Without a session_id the result would default to exited; an
				// unconfirmed exit is reported as the process still running.
				extra: { on_exit: args.on_exit, ...(exited ? {} : { status: "running" as const, running: true }) },
			});
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		watchSessionExit(ctx, session);
		if (pruned) {
			unwatchSessionExit(ctx, pruned.id);
			// Suppresses the wake for live victims; keeps a tombstone for a
			// naturally-exited wake session so its completion is not silently lost.
			ctx.coordinator.handleEviction(pruned);
			ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
		}
		// Note: sessions stay in the store until a later tool call observes the
		// exit: write_stdin returns the final exit_code/output, and list_sessions
		// reports exited sessions one last time (with exit info) before removing
		// them. Matches codex's lazy-drain so exit information is never silently
		// lost across turns.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();

		session.touch();
		const stillAlive = !session.hasExited;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) still delivers the completion exactly once.
			if (wantsWake) ctx.coordinator.register(session);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: heldOpenNote(session),
				},
			});
		}
		// Process exited during this call → respond with exit info, not a
		// session_id. The wake is never armed: the exit was delivered directly.
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			logPath: session.logPath,
			cwd: effectiveCwd,
			shell: session.shell,
			command: args.cmd,
			yieldTimeMs,
			extra: {
				on_exit: args.on_exit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
			},
		});
	} finally {
		ctx.pendingSessions.delete(session);
		// Short-lived commands never enter the store; release their terminal here.
		if (ctx.store.get(session.id) !== session) void session.release();
	}
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "write_stdin" });
	const writeBytes = resolveWriteInput(args);
	const session = ctx.store.get(args.session_id);
	if (!writeBytes?.length) throw new EmptyPollRemovedError(session?.terminalUrl);
	if (!session) throw new Error(`unknown session_id: ${args.session_id}`);

	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);

	const start = Date.now();
	session.touch();

	// Observation lease: while this call may return terminal status, a
	// concurrent exit is held instead of enqueuing a wake (see completion.ts).
	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		let writeFailure: string | null = null;
		if (writeBytes) {
			const ok = session.write(writeBytes);
			if (!ok && !session.hasExited) {
				// Still running but the PTY no longer accepts input (terminal closed).
				writeFailure = "PTY write failed: the terminal no longer accepts input; bytes were not delivered";
			}
			if (!ok && session.hasExited) {
				// Session already exited; return its final state.
				const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
				const armed = ctx.coordinator.isArmed(session.id);
				removeSession(ctx, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				const wallSec = (Date.now() - start) / 1000;
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage,
					logPath: session.logPath,
					cwd: session.cwd,
					shell: session.shell,
					command: session.displayCommand,
					yieldTimeMs,
					extra: terminalWriteExtra(armed),
				});
			}
			// Give the child a small window to react before collecting.
			await sleep(100, signal);
		}

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();
		const wallSec = (Date.now() - start) / 1000;

		if (session.hasExited) {
			const armed = ctx.coordinator.isArmed(session.id);
			removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				logPath: session.logPath,
				cwd: session.cwd,
				shell: session.shell,
				command: session.displayCommand,
				yieldTimeMs,
				extra: terminalWriteExtra(armed),
			});
		}
		// Still running: release the lease WITHOUT marking observed — the wake
		// (if armed) stays eligible.
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
			logPath: session.logPath,
			cwd: session.cwd,
			shell: session.shell,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
				note: heldOpenNote(session),
			},
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

/** Shared "exited" extra fields for direct terminal delivery. */
function terminalWriteExtra(wakeWasArmed: boolean): Partial<ResponseShape> {
	return {
		completion_delivery: "direct",
		tool_time_utc: nowUtcIso(),
		...(wakeWasArmed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
	};
}


/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	/** true when the process is confirmed dead; false = kill did NOT land. */
	killed: boolean;
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store — but ONLY on confirmed
 * exit. A kill that doesn't land (taskkill failure, access denied,
 * unkillable state) keeps the session in the store and returns
 * killed: false, so ownership of a live process is never silently dropped.
 * Shared by the kill_session tool and the /unified-exec-sessions command.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
	origin: "model" | "human" = "human",
): Promise<TerminateOutcome | undefined> {
	if (origin === "model") ctx.coordinator.cancelMonitor(sid);
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill (model tool or human slash command): suppress the wake
	// BEFORE signaling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	if (origin === "human") ctx.coordinator.monitorEndReason(sid, "human_terminated");
	session.kill(initial);
	// Event-driven wait (resolves the instant the exit fires): up to 2s.
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	let escalated = false;
	// On Windows every kill is already a force tree-kill (taskkill /T /F);
	// a "SIGKILL escalation" would spawn a byte-identical taskkill that
	// cannot behave differently, so skip it there.
	if (!session.hasExited && !IS_WINDOWS) {
		session.kill("SIGKILL");
		escalated = true;
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	// Final drain.
	const collected = await session.collect({ deadlineMs: Date.now() + 100 });
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		removeSession(ctx, sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
		ctx.coordinator.monitorEndReason(sid, "natural");
	}
	return { session, escalated, collected, killed };
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		`⚠ unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
			const held = s.shellExited ? " (shell exited, terminal held)" : "";
			return `  #${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`;
		}),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `unified-exec: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/list_sessions/kill_session observes it. The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

/** Shared non-consuming streaming-update payload for exec and input attachment. */
function buildStreamUpdate(session: ExecSession): AgentToolResult<ProcessUpdateDetails> {
	const snapshot = session.liveSnapshot();
	const text = snapshot ? sanitizeOutputText(snapshot.text) : "";
	return {
		content: [{ type: "text", text }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			command: session.displayCommand,
			cwd: session.cwd,
			shell: session.shell,
			log_path: session.logPath,
			// Populate `output` so renderResult has a single source regardless
			// of streaming vs final state.
			output: text,
			...(snapshot ? { terminal: terminalViewDetails(snapshot.view, true) } : {}),
		},
	};
}

function startStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = () => {
		if (stopped) return;
		try {
			onUpdate(buildStreamUpdate(session));
		} catch {
			// ignore transient errors
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

/** Activate the tool core; the default factory supplies omp's appearance and live shell setting. */
export function activate(
	pi: ExtensionAPI,
	appearance: () => TerminalAppearance = () => "dark",
	shellPath?: () => string | undefined,
	approvalHost?: CommandApprovalHost,
	invalidateGithubCache?: (command: string) => void,
): ActivatedExtension {
	let binding: HostBindingState = { kind: "pending" };
	const coordinator = new CompletionCoordinator({
		send: (message) => {
			// If pi is idle this starts a model turn; if a run is active it is
			// queued as a follow-up — never steering/interrupting the current turn.
			pi.sendMessage(
				{
					customType: "unified-exec-completed",
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		sendMonitor: (message) => {
			pi.sendMessage(
				{ customType: "unified-exec-monitor", content: message.content, display: true, details: message.details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		sendInputWait: (message) => {
			pi.sendMessage(
				{ customType: "unified-exec-input-wait", content: message.content, display: true, details: message.details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onSendError: (err) => {
			ctx.ui?.notify(
				`unified-exec: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		store: new SessionStore({
			maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT,
			onEvict: (session, reason) => {
				if (reason === "lru" && !session.hasExited) coordinator.monitorEndReason(session.id, "lru_terminated");
			},
		}),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		warnedShellFallback: false,
		notifiedBashSource: false,
		pendingSessions: new Set(),
		shuttingDown: false,
		appearance,
		shellPath,
		invalidateGithubCache,
	};

	// Observation finalization: "observed" is committed at pi's finalized
	// tool-result event, not merely when the handler returns — see completion.ts.
	pi.on("tool_execution_end", async (event) => {
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	pi.on("agent_settled", async () => {
		ctx.coordinator.flushPending();
	});

	pi.on("session_start", async (_event, eventCtx) => {
		if (approvalHost && binding.kind === "pending") binding = bindSession(approvalHost, bindingContext(eventCtx));
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		ctx.coordinator.reset(); // never resurrect wakes from a previous session
		updateRunningSessionsUi(ctx);
	});

	// omp lifecycle events absent from the Pi dependency's public declarations.
	const onSessionChange = (pi as ExtensionAPI & {
		on(event: "session_switch" | "session_branch",
			handler: (event: unknown, context: unknown) => Promise<void>): void;
	}).on;
	for (const event of ["session_switch", "session_branch"] as const) {
		onSessionChange.call(pi, event, async (_event, eventCtx) => {
			binding = recheckBinding(binding, bindingContext(eventCtx));
		});
	}

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async () => {
		// Reject new sessions from here on and terminate everything we own —
		// including sessions still inside exec_command's early-exit grace
		// window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		// Cancel wake timers/listeners first: no stale prompt may ever be
		// injected into a new or closed session.
		ctx.coordinator.shutdown();
		const drained = ctx.store.terminateAll();
		for (const s of ctx.pendingSessions) {
			void s.releaseForShutdown();
			if (!s.hasExited) {
				s.terminate();
				drained.push(s);
			}
		}
		// Shutdown now owns these: their exec_command must not insert them into
		// the store once its grace ends (the store belongs to this ended period).
		ctx.pendingSessions.clear();
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation. On Windows the
		// initial kill is already a force tree-kill and a second taskkill is
		// byte-identical, so skip the escalation there (the grace wait above
		// still confirms exits). Event-driven per session: each wait resolves
		// the instant that session's exit fires.
		await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_TERM_GRACE_MS })));
		if (!IS_WINDOWS) {
			const survivors = drained.filter((s) => !s.hasExited);
			for (const s of survivors) s.kill("SIGKILL");
			await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_KILL_GRACE_MS })));
		}
		if (drained.length && ctx.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.ui.notify(
				`unified-exec: terminated ${drained.length - leftover} live session(s) on shutdown` +
					(leftover ? `; ${leftover} did not confirm exit` : ""),
				 leftover ? "warning" : "info",
			);
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("unified-exec-sessions", {
		description: "List live unified-exec sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			// Reap silently-exited sessions first so the picker only shows live ones.
			for (const s of ctx.store.values()) {
				if (s.hasExited) removeSession(ctx, s.id);
			}
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("unified-exec: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
				const held = s.shellExited ? " (shell exited, terminal held)" : "";
				return `#${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 60)}`;
			});
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`unified-exec: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				`unified-exec: killed ${killed} ${plural(killed, "session")}` +
					(failed ? `; ${failed} did not confirm exit (still listed)` : ""),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		...(approvalHost ? {
			approval: (args: unknown) => approveBoundCommand(approvalHost, binding, args),
			formatApprovalDetails: (args: unknown) => [`Command: ${approvalHost.helpers.truncateForPrompt(approvalCommand(args, "(missing)"))}`],
		} : {}),
		description:
			'Run a command in a PTY session for long-running, interactive (REPLs, TUIs, ssh, sudo), concurrent or dev-daemon work; use bash for short one-shot commands. There is no command deadline and nothing restarts a process that exits. Returns `session_id` if still running (drive with write_stdin, observe with monitor or read terminal_url) or `exit_code` if it finished within yield_time_ms. on_exit defaults to "none". Only pass on_exit: "wake" when the human explicitly wants auto-resume on unobserved exit — stale wakes interrupt later work. Use set_on_exit to disarm or re-arm a running session.',
		promptSnippet: "Run a long-running or interactive command in a PTY session",
		promptGuidelines: [
			"Use bash for short one-shot commands. Use exec_command for long-running commands, interactive programs (REPLs, TUIs, ssh, sudo), concurrent computation and dev-time daemons: it runs in a PTY, has no command deadline, and never restarts a process that exits.",
			"Shell selection: explicit shell argument, then omp shellPath, then $SHELL, then the platform default (bash, or Git Bash/PowerShell on Windows). Results name the selected shell; write commands in that shell's syntax. Working directory defaults to the current host session cwd.",
			"The 10s default yield suits most starts; interactive processes return a session_id you then drive with write_stdin.",
			"For a long non-interactive command, start with a short yield to obtain a session_id. Read terminal_url for progress; use monitor with a condition for future progress lines, or without one to await completion. Use write_stdin only to send input. omp manages cache warming independently.",
			'on_exit defaults to "none". Prefer monitor or human follow-up. Use on_exit: "wake" ONLY when the human explicitly wants auto-resume on unobserved completion — not for indefinite processes (dev servers, watchers). If you armed wake by mistake or the job is wrong/abandoned, call set_on_exit(session_id, on_exit: "none") promptly (does not kill the process). kill_session still kills and suppresses wake. Combining wake with an input-bearing write_stdin is safe: direct completion consumes the wake.',
			"Output is rendered terminal state, not raw bytes. Running results show unseen history plus the current screen and cursor; unchanged running screens report screen_changed:false. Completed results show only the frozen final active screen. Read terminal_url for what the terminal shows (retained history, or a full-screen program's screen such as tmux while it runs), /screen for active text, or /screen.png for cell colours and styling; raw bytes remain in log_path.",
		],
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell executable. Defaults to omp shellPath, then $SHELL, then bash (Windows: Git Bash, else PowerShell). Results report the actual shell. cmd and PowerShell receive shell-appropriate flags; other shells use -c.",
				}),
			),
			cols: Type.Optional(
				Type.Number({
					description: `PTY width in columns. Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].`,
				}),
			),
			rows: Type.Optional(
				Type.Number({
					description: `PTY height in rows. Default ${DEFAULT_PTY_ROWS}, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].`,
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) this call stays attached waiting for output before yielding — an attachment window, not the command's lifetime or completion timeout. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
			on_exit: Type.Optional(
				StringEnum(
					["none", "wake"] as const,
					'"none" (default): no auto-resume; read terminal_url for state/content and use monitor for events or completion. "wake": ONE follow-up notification on unobserved exit that resumes the agent — only when the human explicitly wants auto-resume. Change later via set_on_exit. A completion observed directly by a tool result consumes the wake.',
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params, signal, onUpdate, eventCtx.cwd);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Write nonempty input bytes verbatim to a running session's PTY; nothing (no \\r or \\n) is appended. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\r Enter); use `chars_b64` for raw binary. Read state and content with read terminal_url (term://); wait for output events or completion with monitor. Zero-byte input is rejected with empty_poll_removed.",
		promptSnippet: "Send nonempty input to a running session",
		promptGuidelines: [
			"write_stdin only sends input. Use read term:// for state/content without consuming observations; use monitor with a condition for future output events, or without a condition to await completion.",
			"Input-bearing calls retain their attachment window: default 250ms, clamped to [250, 30000]. Cancellation leaves the process alive.",
			'on_exit wake is set via exec_command or set_on_exit, not write_stdin. Observing an exit here consumes an armed wake (direct result). To disarm wake without killing, call set_on_exit(session_id, on_exit: "none").',
			"Submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r. Keys such as ESC or arrows are sent alone, without Enter.",
			"For very noisy jobs, use monitor for events and read terminal_url or log_path for output.",
		],
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `Attachment window in ms, not a process timeout. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params, signal, onUpdate, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
	});

	pi.registerTool({
		name: "set_on_exit",
		label: "set_on_exit",
		description:
			'Change on_exit policy for a session without killing it. on_exit: "none" disarms a pending wake (including coordinator tombstones after eviction). on_exit: "wake" arms auto-resume if the process is still running. Cannot recall a follow-up already queued to the agent. kill_session both kills and suppresses.',
		promptSnippet: "Disarm or re-arm on_exit wake for a session",
		promptGuidelines: [
			'Default on_exit is "none". If you set "wake" and no longer need auto-resume (wrong command, user moved on, abandoned approach), call set_on_exit with "none" promptly — do not leave stale wakes armed.',
			"This does not stop the process. Use kill_session to terminate.",
			"Prefer arming wake only when the human explicitly asked for auto-resume.",
			"Disarm cannot recall a completion follow-up that was already delivered to pi.",
		],
		outputSchema: setOnExitScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			on_exit: StringEnum(
				["none", "wake"] as const,
				'"none": disarm wake (process keeps running). "wake": arm auto-resume if still running.',
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const { session_id: sid, on_exit: policy } = params as { session_id: number; on_exit: OnExitPolicy };
			const session = ctx.store.get(sid);
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			// unknown id: no store session and nothing to disarm
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			const text =
				`set_on_exit session_id=${sid} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				structuredContent: setOnExitScriptResult({
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
				}),
				details: {
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
					command: session?.displayCommand,
					log_path: session?.logPath,
					tool_time_utc: nowUtcIso(),
				},
			};
		},
	});

	pi.registerTool({
		name: "monitor",
		label: "monitor",
		description: "Wait for future output events or completion of an existing session. An optional JavaScript regex condition wakes the agent for each matched batch; omit it to await output closure once. If the monitor returns nothing for remind_after_ms (default 20 minutes) it sends one reminder to check the session and stays active. Read state/content with read terminal_url (term://), and send input with write_stdin. Replaces any existing monitor; action cancel silently removes it. Default max_returns is 10 successful match messages.",
		promptSnippet: "Await matching output or completion of an existing session",
		promptGuidelines: [
			"Monitor observes without consuming output. Use read term:// for history and screens, and log_path for raw bytes.",
			"Only output after establishment participates. Match batches coalesce for about 250ms; the final allowed return ends the monitor, not the process.",
			"A monitor that has not returned for remind_after_ms (default 20 minutes) sends one reminder with the session's current screen; each delivered match starts a new silent period. On a reminder, read the terminal and decide: answer a prompt with write_stdin, keep waiting by calling monitor again, or cancel. Pass a larger remind_after_ms only when a longer silence is expected.",
			"Independently of monitors, a session whose screen settles on an unseen input prompt (a debconf/whiptail dialog, [Y/n], password, pager) produces a unified-exec input-wait alert.",
			"Model kill_session, explicit cancel, replacement and session reset silently cancel monitoring. Already delivered follow-ups cannot be recalled.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Existing running session id." }),
			action: Type.Optional(StringEnum(["start", "cancel"] as const, "start (default) establishes/replaces; cancel silently removes.")),
			condition: Type.Optional(Type.String({ description: "JavaScript regular expression source, no / delimiters. Omit to wait only for completion." })),
			max_returns: Type.Optional(Type.Number({ description: "Positive safe integer; default 10 successful matched batches. End does not count." })),
			remind_after_ms: Type.Optional(Type.Number({ description: "Silence (no match or End delivered) before one reminder that the monitor has not returned; default 1200000 (20 minutes), integer 1–2147483647. The reminder does not count toward max_returns and does not end the monitor." })),
		}),
		outputSchema: monitorScriptResultSchema,
		async execute(_toolCallId, params, signal) {
			let details: MonitorScriptResult;
			try {
				if (params.action === "cancel") {
					details = { session_id: params.session_id, status: coordinator.cancelMonitor(params.session_id) ? "cancelled" : "not_monitored" };
				} else {
					const session = ctx.store.get(params.session_id);
					if (!session) throw new MonitorError("unknown_session", `No such session: ${params.session_id}`);
					const monitor = await coordinator.startMonitor(session, { condition: params.condition, maxReturns: params.max_returns, remindAfterMs: params.remind_after_ms }, signal);
					details = { session_id: params.session_id, status: "started", monitor };
				}
			} catch (error) {
				if (!(error instanceof MonitorError)) throw error;
				details = { session_id: params.session_id, status: "error", code: error.code, message: error.message };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details, structuredContent: details,
				...(details.status === "error" ? { isError: true } : {}),
			};
		},
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session (SIGTERM, escalates to SIGKILL after 2s; on Windows any signal force-kills the process tree). Use when the process won't exit via Ctrl-C. session_id is invalid after confirmed exit. Also suppresses any armed on_exit wake and silently cancels its monitor before signaling, even if termination fails.",
		promptSnippet: "Terminate a session",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, "model");
			if (!outcome) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
					structuredContent: killNotFoundScriptResult(sid),
				};
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the session remains registered — retry kill_session or check permissions",
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: sid,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				logPath: session.logPath,
				cwd: session.cwd,
				shell: session.shell,
				command: session.displayCommand,
				escalated,
				killed,
			});
			return {
				content: [{ type: "text", text: renderKillResultText(details) }],
				details,
				structuredContent: killScriptResult(details),
			};
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List all live unified-exec sessions in this omp run.",
		promptSnippet: "List live sessions",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them) — but report each of them
			// one final time with exit info instead of dropping them on the floor.
			// This mirrors codex's `refresh_process_state` filter while preserving
			// our "exit information is never silently lost" guarantee.
			const reaped: ExecSession[] = [];
			for (const s of ctx.store.values()) {
				if (s.hasExited) {
					// Reporting terminal completion here counts as direct observation:
					// suppress a not-yet-queued wake (an already-queued wake stays a
					// single notification — never a second one).
					ctx.coordinator.observeViaListing(s.id);
					removeSession(ctx, s.id);
					reaped.push(s);
				}
			}
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const live = ctx.store.values();
			const sessions = [...live, ...reaped]
				.sort((a, b) => a.id - b.id)
				.map((s) => ({
					session_id: s.id,
					command: s.displayCommand,
					cwd: s.cwd,
					shell: s.shell,
					pid: s.pid,
					started_at_ms: s.startedAt,
					elapsed_ms: now - s.startedAt,
					running: !s.hasExited,
					wake_armed: ctx.coordinator.isArmed(s.id),
					monitor: ctx.coordinator.monitorStatus(s.id),
					exit_code: s.hasExited ? s.exitCode : undefined,
					signal: s.hasExited ? (s.signal ?? undefined) : undefined,
					failure_message: s.failureMessage ?? undefined,
					output_bytes_total: s.totalBytesSeen,
					log_path: s.logPath,
					terminal_url: s.terminalUrl,
				}));
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; removed from store]`;
						const wake = s.wake_armed ? " [wake]" : "";
						const monitor = s.monitor ? ` [monitor ${s.monitor.returns}/${s.monitor.max_returns} condition=${JSON.stringify(s.monitor.condition)} remind_after=${formatElapsed(s.monitor.remind_after_ms)}]` : "";
						return `  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}${monitor}  ${oneLineCommand(s.command, 60)}${exitedSuffix}\n        shell: ${sanitizeMeta(s.shell ?? "")}\n        log: ${s.log_path}${s.terminal_url ? `\n        terminal_url: ${s.terminal_url}` : ""}`;
					})
				: ["  (no live sessions)"];
			const header = reaped.length
				? `unified-exec sessions (${live.length} live, ${reaped.length} just exited):`
				: `unified-exec sessions (${live.length}):`;
			return {
				// Report the host clock alongside this inventory snapshot.
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, active_count: live.length, just_exited_count: reaped.length, tool_time_utc: toolTimeUtc },
				structuredContent: listSessionsScriptResult({
					sessions,
					active_count: live.length,
					just_exited_count: reaped.length,
					tool_time_utc: toolTimeUtc,
				}),
			};
		},
	});

	return {
		store: ctx.store,
		// A human kill from the Tern HUD: same path as the slash command.
		kill: async (id) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM");
			updateRunningSessionsUi(ctx);
			return outcome?.killed === true;
		},
	};
}

// Fork: on oh-my-pi, tools present through omp's bash renderer and sessions
// get a Tern HUD (fork-features/README.md).
export default withHostPresentation(activate);
