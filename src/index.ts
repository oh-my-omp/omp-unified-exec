/**
 * unified-exec — omp extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM (the host's `bash` stays active for short one-shot
 * commands):
 *   - exec_command(cmd, title, workdir?, shell?, cols?, rows?, yield_time_ms?, on_exit?)
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
 *   - A background terminal stays listed after its command returns until the
 *     terminal lifecycle reclaims it (fork-features/terminal-lifecycle.ts);
 *     every follow-up about a terminal is a terminal notice
 *     (fork-features/terminal-notice.ts).
 *   - Every byte the child writes goes to a per-session log file at
 *     <tmpdir>/pi-unified-exec-<pid>-<sid>-<random>.log. The LLM sees the rendered
 *     screen (capped at ~50 KiB / 2000 lines); the raw stream stays in the log.
 *     Logs untouched for seven days become `<log>.gz` (fork-features/log-archive.ts).
 */

import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type TUnsafe } from "typebox";

import { type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { approvalCommand, approveBoundCommand, type CommandApprovalHost } from "../fork-features/command-approval.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "../fork-features/session-binding.ts";
import { MonitorError } from "../fork-features/monitor-subscription.ts";
import { loadStopConfig } from "../fork-features/stop-config.ts";
import { detectStop, type StopHost } from "../fork-features/stop-gate.ts";
import { type LifecycleClock, type ReclaimResult, TerminalLifecycle } from "../fork-features/terminal-lifecycle.ts";
import { buildNoticeDisplayMessage, MAX_TITLE_CHARS, NoticeDispatcher, type NoticeGate, outcomeText, parseTerminalTitle } from "../fork-features/terminal-notice.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed, formatElapsedUi, nowUtcIso } from "./format-time.ts";
import { tr } from "./i18n.ts";
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
// Probe interval while confirming that a reclaimed terminal's leftover process group is gone.
const GROUP_PROBE_MS = 50;
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
	/** The one delivery path for terminal notices. */
	notices: NoticeDispatcher;
	/** Owns background terminals from their session_id to their reclaim. */
	lifecycle: TerminalLifecycle;
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
	title: string;
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
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "exec_command" });
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
	const title = parseTerminalTitle(args.title);
	if (title === undefined) {
		throw new Error(`exec_command: title is required — a short nonblank name for this terminal (at most ${MAX_TITLE_CHARS} characters shown); notices and list_sessions identify the terminal by it.`);
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell(undefined, ctx.shellPath?.());
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				tr(
					"unified-exec: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_UNIFIED_EXEC_BASH.",
					"unified-exec：未找到 bash（PATH、Git 派生路径或已知安装目录）；将回退到 powershell。请安装 Git Bash，或设置 PI_UNIFIED_EXEC_BASH。",
				),
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
			ctx.ui?.notify(
				tr(
					`unified-exec: using bash at ${resolved.shell} (not on PATH)`,
					`unified-exec：正在使用 ${resolved.shell} 中的 bash（不在 PATH 中）`,
				),
				"info",
			);
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
		title,
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
			ctx.lifecycle.evicted(pruned, ctx.store.maxSessions);
			ctx.ui?.notify(
				tr(
					`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`,
					`unified-exec：已淘汰会话 ${pruned.id}（LRU，超过上限 ${ctx.store.maxSessions}）`,
				),
				"warning",
			);
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(
				tr(
					`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`,
					`unified-exec：已打开 ${count}/${ctx.store.maxSessions} 个会话`,
				),
				"warning",
			);
		}

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
			// From here the terminal lifecycle owns it until reclaim. A shell that
			// already exited (its terminal held open) has returned, and this result
			// shows it.
			ctx.lifecycle.track(session);
			ctx.lifecycle.noteToolRead(toolCallId, session.id);
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
				// The terminal stays listed until its lifecycle reclaims it; this
				// result shows the returned terminal, which counts as a read.
				ctx.lifecycle.noteToolRead(toolCallId, session.id);
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
			ctx.lifecycle.noteToolRead(toolCallId, session.id);
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
		// A shell that already exited (terminal held open) has returned; the result shows it.
		ctx.lifecycle.noteToolRead(toolCallId, session.id);
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


/** Result of terminating a session via kill_session, a human kill or a reclaim. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	/** true when the process is confirmed dead; false = kill did NOT land. */
	killed: boolean;
}

/**
 * Who ends the session. A kill by the model or a human is a normal ending:
 * the terminal stays listed and its lifecycle reclaims it later (a
 * terminal the lifecycle does not own leaves at once). A reclaim removes it.
 */
type TerminateOrigin =
	| { readonly kind: "model"; readonly toolCallId: string }
	| { readonly kind: "human" }
	| { readonly kind: "reclaim" };

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation) and drain
 * its trailing output. A kill that doesn't land (taskkill failure, access
 * denied, unkillable state) keeps the session and returns killed: false, so
 * ownership of a live process is never silently dropped.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
	origin: TerminateOrigin,
): Promise<TerminateOutcome | undefined> {
	if (origin.kind !== "human") ctx.coordinator.cancelMonitor(sid);
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill: suppress the wake BEFORE signaling so the induced exit can
	// never race a wake enqueue, and mark the coming return as a normal ending.
	ctx.coordinator.suppress(sid);
	ctx.lifecycle.noteKill(sid);
	if (origin.kind === "human") ctx.coordinator.monitorEndReason(sid, "human_terminated");
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
		if (origin.kind === "reclaim" || !ctx.lifecycle.isTracked(sid)) removeSession(ctx, sid);
		// The model's kill result shows the final screen; a human ended it while looking at it.
		else if (origin.kind === "model") ctx.lifecycle.noteToolRead(origin.toolCallId, sid);
		else ctx.lifecycle.markRead(sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
		ctx.coordinator.monitorEndReason(sid, "natural");
		ctx.lifecycle.killFailed(sid);
	}
	return { session, escalated, collected, killed };
}

/**
 * After its terminal closed, a session's process group can still have
 * members: on macOS the terminal closes with the shell while background jobs
 * keep running. Reclaim ends them too — SIGTERM, then SIGKILL — and confirms
 * the group is empty. No exit event exists for processes that are not our
 * child, so the confirmation probes the group with signal 0.
 */
async function killLeftoverGroup(session: ExecSession): Promise<"none" | "killed" | "survived"> {
	if (!session.hasExited || !session.signalProcessGroup(0)) return "none";
	const goneWithin = async (ms: number): Promise<boolean> => {
		for (let waited = 0; waited < ms; waited += GROUP_PROBE_MS) {
			if (!session.signalProcessGroup(0)) return true;
			await sleep(GROUP_PROBE_MS);
		}
		return !session.signalProcessGroup(0);
	};
	session.signalProcessGroup("SIGTERM");
	if (await goneWithin(2000)) return "killed";
	session.signalProcessGroup("SIGKILL");
	return (await goneWithin(500)) ? "killed" : "survived";
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function sessionWord(count: number): string {
	return count === 1 ? tr("session", "会话") : tr("sessions", "会话");
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
		tr(
			`⚠ unified-exec: ${sessions.length} ${sessionWord(sessions.length)} still running`,
			`⚠ unified-exec：${sessions.length} 个会话仍在运行`,
		),
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? tr(" [wake]", " [已唤醒]") : "";
			const held = s.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
			const elapsed = formatElapsedUi(now - s.startedAt);
			return tr(
				`  #${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)} (${s.cwd})`,
				`  #${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}（${s.cwd}）`,
			);
		}),
	];
	if (sessions.length > shown.length) {
		lines.push(tr(
			`  … ${sessions.length - shown.length} more; use list_sessions`,
			`  … 还有 ${sessions.length - shown.length} 个；使用 list_sessions`,
		));
	}
	lines.push(tr(
		"  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.",
		"  使用 list_sessions、write_stdin、set_on_exit（取消唤醒）或 kill_session。",
	));
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length
		? tr(
			`unified-exec: ${sessions.length} ${sessionWord(sessions.length)} running`,
			`unified-exec：${sessions.length} 个会话正在运行`,
		)
		: undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			tr(
				`unified-exec: ${sessions.length} ${sessionWord(sessions.length)} still running after /tree.`,
				`unified-exec：/tree 后仍有 ${sessions.length} 个会话在运行。`,
			),
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
		// An exited session stays in the store until its lifecycle reclaims it.
		// The UI only reflects currently running processes.
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

/** The text of omp's `session_stop` final response; undefined when it carries none. */
function finalResponseText(event: unknown): string | undefined {
	const message: unknown = typeof event === "object" && event !== null ? Reflect.get(event, "last_assistant_message") : undefined;
	const content: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "content") : undefined;
	const text = typeof content === "string" ? content : Array.isArray(content)
		? content.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
		: "";
	return text.trim() ? text : undefined;
}

/**
 * Activate the tool core; the default factory supplies omp's appearance and
 * live shell setting. `lifecycleClock` replaces the host clock for terminal
 * TTLs and the minute sweep; `stopHost` enables stop decisions.
 */
export function activate(
	pi: ExtensionAPI,
	appearance: () => TerminalAppearance = () => "dark",
	shellPath?: () => string | undefined,
	approvalHost?: CommandApprovalHost,
	invalidateGithubCache?: (command: string) => void,
	lifecycleClock: LifecycleClock = {},
	stopHost?: StopHost,
): ActivatedExtension {
	let binding: HostBindingState = { kind: "pending" };
	// The conversation the stop gate reads its config and todo list for, from the latest session_start.
	let hostCwd: string | undefined;
	let agentId: string | undefined;
	const reportedConfigProblems = new Set<string>();
	const gate: NoticeGate | undefined = stopHost && {
		config: () => {
			const load = loadStopConfig(hostCwd, stopHost.getAgentDir());
			for (const problem of load.problems) {
				const key = `${problem.path}\n${problem.reason}`;
				if (reportedConfigProblems.has(key)) continue;
				reportedConfigProblems.add(key);
				ctx.ui?.notify(
					tr(`unified-exec: ignoring ${problem.path}: ${problem.reason}`, `unified-exec：忽略 ${problem.path}：${problem.reason}`),
					"warning",
				);
			}
			return load.config;
		},
		detect: (config, input, signal) => detectStop({
			host: stopHost,
			session: () => (binding.kind === "bound" ? binding.session : undefined),
			readTodo: () => {
				if (agentId === undefined) return undefined;
				let reply: unknown;
				pi.events.emit("omp-todo-more:read", { agentId, reply: (value: unknown) => { reply = value; } });
				return reply;
			},
		}, config, input, signal),
		collect: async () => {
			await ctx.lifecycle.collectReturned();
			updateRunningSessionsUi(ctx);
		},
		tracked: (sessionId) => ctx.lifecycle.isTracked(sessionId),
		verdict: (verdict) => {
			switch (verdict.kind) {
				case "done":
					ctx.ui?.notify(
						tr(
							`unified-exec: the agent's work is done (${verdict.detector}); returned terminals reclaimed, their notices dropped`,
							`unified-exec：判定 agent 已完成（${verdict.detector}）；已回收返回的终端并丢弃其通知`,
						),
						"info",
					);
					return;
				case "not_done":
					return;
				case "undecided":
					if (verdict.cause === "failed") {
						ctx.ui?.notify(tr(`unified-exec: stop decision failed: ${verdict.reason}`, `unified-exec：完成判定失败：${verdict.reason}`), "warning");
					}
					return;
			}
		},
	};
	const notices = new NoticeDispatcher({
		// Sent only while the agent is stopped, so it starts one model turn.
		send: (message) => {
			pi.sendMessage(
				{ customType: "unified-exec-notice", content: message.content, display: true, details: message.details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		gate,
		onSendError: (err) => {
			ctx.ui?.notify(
				tr(
					`unified-exec: failed to deliver a terminal notice: ${err instanceof Error ? err.message : String(err)}`,
					`unified-exec：终端通知投递失败：${err instanceof Error ? err.message : String(err)}`,
				),
				"warning",
			);
		},
	});
	const coordinator = new CompletionCoordinator({ notices });
	const lifecycle = new TerminalLifecycle({
		...lifecycleClock,
		notices,
		reclaim: async (id): Promise<ReclaimResult> => {
			const session = ctx.store.get(id);
			if (!session) return { kind: "gone", killedProcesses: false };
			const terminalOpen = !session.hasExited;
			const leftover = await killLeftoverGroup(session);
			if (leftover === "survived") return { kind: "held" };
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "reclaim" });
			updateRunningSessionsUi(ctx);
			if (outcome && !outcome.killed) return { kind: "held" };
			return { kind: "gone", killedProcesses: terminalOpen || leftover === "killed" };
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		notices,
		lifecycle,
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
	const registerMessageRenderer = (pi as ExtensionAPI & {
		registerMessageRenderer?: (
			customType: string,
			renderer: (message: { readonly details?: unknown }, options: { readonly outputPad: number }, theme: unknown) => Component | undefined,
		) => void;
	}).registerMessageRenderer;
	registerMessageRenderer?.call(pi, "unified-exec-notice", (message, { outputPad }) => {
		const box = new Box(outputPad, 1);
		box.addChild(new Text(buildNoticeDisplayMessage(message.details), 0, 0));
		return box;
	});


	// Observation finalization: "observed" (and a tool result's read of a
	// returned terminal) is committed at pi's finalized tool-result event, not
	// merely when the handler returns — see completion.ts.
	pi.on("tool_execution_end", async (event) => {
		ctx.lifecycle.commitToolReads(event.toolCallId, event.isError === true);
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	// The run lifecycle the dispatcher delivers by: notices wait while a run is
	// in progress and go out, merged, once it settles for good.
	pi.on("agent_start", async () => {
		ctx.notices.agentStarted();
	});
	pi.on("agent_end", async (event) => {
		// willContinue without awaitingAsyncWork: omp has scheduled a continuation, so the run goes on.
		// awaitingAsyncWork: the session idles until background work (a task, an async job) returns;
		// notices go out as usual meanwhile, and that wait is not a finished task.
		const willContinue = Reflect.get(event, "willContinue") === true;
		const awaitingAsyncWork = Reflect.get(event, "awaitingAsyncWork") === true;
		if (willContinue && !awaitingAsyncWork) return;
		ctx.coordinator.flushPending();
		ctx.notices.agentStopped(awaitingAsyncWork ? "awaiting" : "final");
	});

	pi.on("session_start", async (_event, eventCtx) => {
		if (approvalHost && binding.kind === "pending") binding = bindSession(approvalHost, bindingContext(eventCtx));
		hostCwd = eventCtx.cwd;
		agentId = bindingContext(eventCtx).agentId;
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		// Never resurrect notices or wakes from a previous session.
		ctx.notices.reset();
		ctx.coordinator.reset();
		ctx.lifecycle.restart();
		updateRunningSessionsUi(ctx);
	});

	// omp lifecycle events absent from the Pi dependency's public declarations.
	const onHostEvent = (pi as ExtensionAPI & {
		on(event: "session_switch" | "session_branch" | "session_stop",
			handler: (event: unknown, context: unknown) => Promise<void>): void;
	}).on;
	for (const event of ["session_switch", "session_branch"] as const) {
		onHostEvent.call(pi, event, async (_event, eventCtx) => {
			binding = recheckBinding(binding, bindingContext(eventCtx));
			ctx.notices.forgetResponse();
		});
	}
	// The main agent's final response; returning nothing requests no continuation.
	onHostEvent.call(pi, "session_stop", async (event) => {
		const text = finalResponseText(event);
		if (text !== undefined) ctx.notices.recordResponse(text);
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async () => {
		// Reject new sessions from here on and terminate everything we own —
		// including sessions still inside exec_command's early-exit grace
		// window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		// Cancel lifecycle sweeps, wake timers/listeners and pending notices
		// first: shutdown's own kills create no notices, and no stale prompt may
		// ever be injected into a new or closed session.
		ctx.lifecycle.shutdown();
		ctx.coordinator.shutdown();
		ctx.notices.stop();
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
				tr(
					`unified-exec: terminated ${drained.length - leftover} live session(s) on shutdown${leftover ? `; ${leftover} did not confirm exit` : ""}`,
					`unified-exec：关机时终止了 ${drained.length - leftover} 个活动会话${leftover ? `；${leftover} 个会话未确认退出` : ""}`,
				),
				leftover ? "warning" : "info",
			);
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("unified-exec-sessions", {
		description: tr(
			"List live unified-exec sessions and optionally kill one (or all)",
			"列出正在运行的 unified-exec 会话，并可结束其中一个（或全部）",
		),
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify(
					tr("unified-exec: no live sessions", "unified-exec：没有正在运行的会话"),
					"info",
				);
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? tr(" [wake]", " [已唤醒]") : "";
				const held = s.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
				const elapsed = formatElapsedUi(now - s.startedAt);
				return tr(
					`#${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}`,
					`#${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}`,
				);
			});
			const KILL_ALL = tr(
				`Kill all ${sessions.length} ${sessionWord(sessions.length)}`,
				`结束全部 ${sessions.length} 个会话`,
			);
			const choice = await cmdCtx.ui.select(
				tr(
					`unified-exec: ${sessions.length} live ${sessionWord(sessions.length)} — select to kill (Esc to cancel)`,
					`unified-exec：${sessions.length} 个正在运行的会话——选择要结束的会话（Esc 取消）`,
				),
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM", { kind: "human" });
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				tr(
					`unified-exec: killed ${killed} ${sessionWord(killed)}${failed ? `; ${failed} did not confirm exit (still listed)` : ""}`,
					`unified-exec：已结束 ${killed} 个会话${failed ? `；${failed} 个会话未确认退出（仍在列表中）` : ""}`,
				),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------
	// omp inlines a tool as its description cut at 200 characters plus the
	// parameter schema with comments. Each description's first string is that
	// head and ends on a word at the cut; a rule lives either in the
	// description or in one parameter's comment, never both.

	pi.registerTool({
		name: "exec_command",
		label: tr("Execute command", "执行命令"),
		...(approvalHost ? {
			approval: (args: unknown) => approveBoundCommand(approvalHost, binding, args),
			formatApprovalDetails: (args: unknown) => [
				tr(
					`Command: ${approvalHost.helpers.truncateForPrompt(approvalCommand(args, "(missing)"))}`,
					`命令：${approvalHost.helpers.truncateForPrompt(approvalCommand(args, "（缺失）"))}`,
				),
			],
		} : {}),
		description:
			"Run a command in a PTY for long-running, interactive (REPL, TUI, ssh, sudo), concurrent or daemon work; bash for one-shot commands. No command deadline. Returns session_id if running, else exit_code. " +
			"A process that exits is never restarted. With a session_id, send input with write_stdin, wait for output or completion with monitor, and read terminal_url (term://) for state. " +
			"Results show rendered terminal state, not raw bytes: a running result shows unseen history plus the current screen (screen_changed:false when unchanged), a finished one its final screen. terminal_url gives retained history or a full-screen program's screen, /screen the active text, /screen.png colours and styles; raw bytes stay in log_path. " +
			"Notices name a terminal by session_id and title; they wait while you work and arrive when you stop. A returned terminal stays in list_sessions until reclaimed: an abnormal return is reported at once; 30 minutes after the return or the last read, a never-read terminal gets a read reminder and a read one a reclaim notice, after which it is killed with its background jobs and unlisted unless read within 5 minutes. When your final response shows the task finished, returned terminals are reclaimed silently. term:// stays readable after reclaim.",
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			title: Type.String({ description: `Terminal name in list_sessions, the Terminals view and every notice: one nonblank line, at most ${MAX_TITLE_CHARS} characters kept.` }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell executable. Defaults to omp shellPath, then $SHELL, then bash (Windows: Git Bash, else PowerShell). Write cmd in that shell's syntax; results name it.",
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
					description: `How long (ms) this call waits for output before returning. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
			on_exit: Type.Optional(
				StringEnum(
					["none", "wake"] as const,
					'"none" (default). "wake": resume you once when the process exits unobserved; only when the human explicitly asks, never for servers or watchers. A tool result observing the exit consumes it; set_on_exit changes it.',
				),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params, signal, onUpdate, eventCtx.cwd, toolCallId);
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
		label: tr("Send input", "发送输入"),
		description:
			"Send input to a running session's PTY; returns output like exec_command. Bytes go verbatim with nothing appended: end each line with \\r (Windows console programs ignore \\n); send ESC or arrows alone. " +
			"Empty input is rejected with empty_poll_removed. To read without writing use terminal_url; to wait use monitor. An exit observed here consumes an armed wake; cancellation leaves the process alive.",
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
		label: tr("Set exit wake", "设置退出唤醒"),
		description:
			"Change a session's on_exit policy without stopping the process; kill_session terminates it and suppresses the wake. A follow-up already queued cannot be recalled.",
		outputSchema: setOnExitScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			on_exit: StringEnum(
				["none", "wake"] as const,
				'"none": disarm (also after eviction) as soon as auto-resume is unwanted. "wake": arm auto-resume while running, only when the human explicitly asked.',
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
		label: tr("Monitor", "监视"),
		description:
			"Wait for a running session's future output: each batch matching condition wakes you, or without condition its end wakes you once. Observes without consuming output; only output after the call counts. " +
			"Matches coalesce for about 250 ms. kill_session or a session reset also ends a monitor silently; delivered follow-ups cannot be recalled. On a no-return reminder, read the terminal, then answer a prompt with write_stdin, call monitor again, or cancel. A session settling on an unseen input prompt raises an input-wait alert with or without a monitor.",
		parameters: Type.Object({
			session_id: Type.Number({ description: "Existing running session id." }),
			action: Type.Optional(StringEnum(["start", "cancel"] as const, "start (default) establishes or replaces; cancel removes silently.")),
			condition: Type.Optional(Type.String({ description: "JavaScript regex source without / delimiters. Omit to await completion only." })),
			max_returns: Type.Optional(Type.Number({ description: "Positive safe integer; default 10 matched batches. End does not count; the last return ends the monitor, not the process." })),
			remind_after_ms: Type.Optional(Type.Number({ description: "Silence before one reminder quoting the current screen; default 1200000 (20 minutes), integer 1–2147483647. A match restarts it; the reminder neither counts toward max_returns nor ends the monitor." })),
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
		label: tr("Terminate session", "结束会话"),
		description:
			"Terminate a session: SIGTERM, then SIGKILL after 2 s; on Windows any signal force-kills the process tree. A kill is a normal ending; the result shows the final screen, which counts as a terminal read. " +
			"Before signaling it suppresses an armed on_exit wake and cancels the monitor, even if termination fails. The terminal stays listed until reclaimed.",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, { kind: "model", toolCallId });
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
		label: tr("List sessions", "列出会话"),
		description: "List this omp run's unified-exec terminals: running ones, and returned ones not yet reclaimed, with their titles and lifecycle state.",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Reporting a terminal's exit here counts as direct observation of its
			// completion: a wake not yet sent is suppressed. It is not a read of
			// its output; the terminal stays listed until its lifecycle reclaims it.
			for (const s of ctx.store.values()) if (s.hasExited) ctx.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const stored = ctx.store.values();
			const sessions = stored
				.sort((a, b) => a.id - b.id)
				.map((s) => {
					const life = ctx.lifecycle.status(s.id);
					return {
						session_id: s.id,
						title: s.title,
						command: s.displayCommand,
						cwd: s.cwd,
						shell: s.shell,
						pid: s.pid,
						started_at_ms: s.startedAt,
						elapsed_ms: now - s.startedAt,
						running: !s.hasExited,
						wake_armed: ctx.coordinator.isArmed(s.id),
						monitor: ctx.coordinator.monitorStatus(s.id),
						lifecycle: life ? { returned: outcomeText(life.outcome), read: life.read, phase: life.phase } : undefined,
						exit_code: s.hasExited ? s.exitCode : undefined,
						signal: s.hasExited ? (s.signal ?? undefined) : undefined,
						failure_message: s.failureMessage ?? undefined,
						output_bytes_total: s.totalBytesSeen,
						log_path: s.logPath,
						terminal_url: s.terminalUrl,
					};
				});
			const runningCount = sessions.filter((s) => s.running).length;
			const returnedCount = sessions.filter((s) => s.lifecycle !== undefined).length;
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exited = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}]`;
						const life = s.lifecycle ? `  [returned ${s.lifecycle.returned}; ${s.lifecycle.read ? "read" : "unread"}; ${s.lifecycle.phase}]` : "";
						const wake = s.wake_armed ? " [wake]" : "";
						const monitor = s.monitor ? ` [monitor ${s.monitor.returns}/${s.monitor.max_returns} condition=${JSON.stringify(s.monitor.condition)} remind_after=${formatElapsed(s.monitor.remind_after_ms)}]` : "";
						return `  ${String(s.session_id).padStart(3)}  ${JSON.stringify(s.title)}  pid=${String(s.pid ?? "?").padStart(6)}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}${monitor}  ${oneLineCommand(s.command, 60)}${exited}${life}\n        shell: ${sanitizeMeta(s.shell ?? "")}\n        log: ${s.log_path}${s.terminal_url ? `\n        terminal_url: ${s.terminal_url}` : ""}`;
					})
				: ["  (no terminals)"];
			const header = `unified-exec terminals (${runningCount} running, ${returnedCount} returned):`;
			return {
				// Report the host clock alongside this inventory snapshot.
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, running_count: runningCount, returned_count: returnedCount, tool_time_utc: toolTimeUtc },
				structuredContent: listSessionsScriptResult({
					sessions,
					running_count: runningCount,
					returned_count: returnedCount,
					tool_time_utc: toolTimeUtc,
				}),
			};
		},
	});

	return {
		store: ctx.store,
		// A human kill from the Tern HUD: same path as the slash command.
		kill: async (id) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "human" });
			updateRunningSessionsUi(ctx);
			return outcome?.killed === true;
		},
	};
}

// Fork: on oh-my-pi, tools present through omp's bash renderer and sessions
// get a Tern HUD (fork-features/README.md).
export default withHostPresentation(activate);
