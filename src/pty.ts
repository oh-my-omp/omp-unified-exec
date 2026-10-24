/**
 * PTY spawn through Bun's native terminal.
 *
 * Presents a single `SpawnedChild` abstraction used by `session.ts`.
 * Mirrors codex's `codex_utils_pty::pty`; every session runs in a PTY,
 * so there is no pipe backend.
 */

import { spawn as cpSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";

import { findOnPath, IS_WINDOWS, isFile, resolveBinary } from "./shell.ts";

/** PTY geometry used when the caller does not choose one. */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 80;

export interface SpawnOptions {
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	/** Windows-only: pass args verbatim (needed for cmd.exe quoting). */
	windowsVerbatimArguments?: boolean;
}

/**
 * Signature for the "something exited" callback. `exitCode` may be null when
 * killed by a signal (and `signal` is set in that case). `failureMessage` is
 * set when the "exit" was actually an async spawn/runtime error (e.g. ENOENT
 * for a missing shell binary or a bad cwd) so callers can surface a
 * diagnosable failure instead of a silent empty exit.
 */
export type ExitCallback = (
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	failureMessage?: string,
) => void;

export interface SpawnedChild {
	readonly pid: number | undefined;
	/**
	 * The direct child process (the shell) has exited. Distinct from the
	 * session's exit, which waits for the terminal to close: descendants that
	 * still hold the PTY (e.g. a SIGHUP-immune background job) keep it open,
	 * so the terminal close can lag the process exit indefinitely. Exposed so
	 * callers can explain a session that stays "running" after its shell is
	 * gone.
	 */
	readonly processExited: boolean;
	/** Write raw bytes to the PTY input side. */
	write(data: Uint8Array): boolean;
	/** Subscribe to data chunks (combined stdout+stderr). Returns unsubscribe. */
	onData(handler: (chunk: Uint8Array) => void): () => void;
	/** Subscribe to the child's exit event. Fires at most once. */
	onExit(handler: ExitCallback): void;
	/** Send a signal to the process group; silently no-ops if already dead. */
	kill(signal?: NodeJS.Signals): void;
}

// ---------------- Bun runtime admission ----------------

type BunTerminal = {
	readonly closed: boolean;
	write(data: Uint8Array): number;
	close(): void;
};

type BunSubprocess = {
	readonly pid: number;
	readonly terminal?: BunTerminal;
	kill(signal?: NodeJS.Signals): void;
};

type BunSpawnOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	windowsVerbatimArguments?: boolean;
	terminal: {
		name: string;
		cols: number;
		rows: number;
		data(terminal: BunTerminal, data: Uint8Array): void;
		exit(
			terminal: BunTerminal,
			exitCode: number | null,
			signalCode: number | string | null,
			error?: Error,
		): void;
	};
	onExit(
		subprocess: BunSubprocess,
		exitCode: number | null,
		signalCode: number | string | null,
		error?: Error,
	): void;
};

type BunRuntime = {
	readonly version?: string;
	spawn(command: string[], options: BunSpawnOptions): BunSubprocess;
};

/** Require the host's native PTY capability before extension activation. */
export function requireBunRuntime(
	candidate: unknown = Reflect.get(globalThis, "Bun"),
): BunRuntime {
	const requirement = "omp-unified-exec requires a Bun host with Bun.Terminal";
	if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") {
		throw new Error(`${requirement}; the current runtime is not Bun. Load this plugin in omp.`);
	}
	const fields = candidate as Record<string, unknown>;
	const version = typeof fields.version === "string" ? fields.version : "unknown";
	if (typeof fields.spawn !== "function" || typeof fields.Terminal !== "function") {
		throw new Error(
			`${requirement}; Bun ${version} does not provide Bun.spawn with Bun.Terminal support. Upgrade the omp/Bun host.`,
		);
	}
	return candidate as BunRuntime;
}

// Numeric signal → name, built from the platform's full signal table so our
// ExitCallback always reports SIG* strings (SIGSEGV, SIGPIPE, SIGUSR1, …
// included — a hand-picked subset previously made crashes look like
// exit_code=0). First name wins for aliased numbers (e.g. SIGABRT/SIGIOT).
const SIGNAL_NAMES: Record<number, NodeJS.Signals> = {};
for (const [name, num] of Object.entries(osConstants.signals)) {
	if (SIGNAL_NAMES[num] === undefined) SIGNAL_NAMES[num] = name as NodeJS.Signals;
}

/** Resolve a numeric signal to its SIG* name for the current platform. */
export function signalNameFromNumber(num: number): NodeJS.Signals | null {
	return SIGNAL_NAMES[num] ?? null;
}

/**
 * Windows: force-kill the whole process tree rooted at `pid`.
 *
 * There are no POSIX signals or process groups on Windows. Killing only the
 * direct child (the shell) leaves grandchildren alive holding the console
 * open, which delays the terminal's exit indefinitely and orphans the
 * subtree. `taskkill /T /F` terminates the tree rooted at `pid`. Fire-and-
 * forget: the backend's exit event is the source of truth for exit.
 *
 * Limitation: /T enumerates children of a LIVE root — if the direct child
 * already exited while a backgrounded grandchild lives on, taskkill finds
 * nothing to kill. True group semantics would need a Job Object
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE); POSIX handles this case via
 * process groups (`kill -pid` works after the leader exits).
 */
/**
 * Absolute path to taskkill.exe. Never spawn the bare name: Windows'
 * CreateProcess checks the parent's cwd before PATH, so a taskkill.exe
 * planted in an untrusted repository would execute with every kill.
 */
function taskkillPath(): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return `${root}\\System32\\taskkill.exe`;
}

function killWindowsTree(pid: number): void {
	try {
		const tk = cpSpawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		tk.on("error", () => {});
	} catch {
		// taskkill missing/unspawnable — nothing more we can do
	}
}

function killPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Bun execs the child after the terminal exists, so a missing shell
 * binary surfaces only as a bare non-zero exit with no output. Check it
 * first so the caller gets a diagnosable failure. (exec_command validates
 * the working directory before it gets here.)
 */
function assertSpawnable(opts: SpawnOptions): void {
	const file = opts.command[0];
	if (!file) throw new Error("spawnChild: empty command");
	const found = /[\\/]/.test(file) ? isFile(resolvePath(opts.cwd, file)) : findOnPath(file, opts.env) !== undefined;
	if (!found) throw new Error(`spawn ${file} ENOENT: shell binary not found (check shell binary and workdir: ${opts.cwd})`);
}

/** Spawn a child in the Bun host's native PTY. */
export function spawnChild(opts: SpawnOptions): SpawnedChild {
	assertSpawnable(opts);
	return spawnBunPty(requireBunRuntime(), opts);
}

// ---------------- Bun PTY impl ----------------

type ProcessExit = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failureMessage?: string;
};

function bunSignalName(signalCode: number | string | null): NodeJS.Signals | null {
	if (typeof signalCode === "number") return signalCode === 0 ? null : signalNameFromNumber(signalCode);
	if (
		typeof signalCode === "string" &&
		Object.prototype.hasOwnProperty.call(osConstants.signals, signalCode)
	) {
		return signalCode as NodeJS.Signals;
	}
	return null;
}

export function spawnBunPty(runtime: BunRuntime, opts: SpawnOptions): SpawnedChild {
	let [file, ...args] = opts.command;
	if (!file) throw new Error("spawnChild: empty command");
	if (IS_WINDOWS) file = resolveBinary(file);

	const dataHandlers = new Set<(chunk: Uint8Array) => void>();
	const exitHandlers = new Set<ExitCallback>();
	let processExited = false;
	let terminalClosed = false;
	let finalized = false;
	let processExit: ProcessExit | undefined;
	let terminal: BunTerminal | undefined;
	let bufferingInitialData = true;
	let pendingData: Uint8Array[] = [];

	const emitData = (chunk: Uint8Array) => {
		if (finalized) return;
		if (bufferingInitialData) {
			// Bun may invoke terminal callbacks before spawn() returns. Preserve
			// those bytes until ExecSession can subscribe to the returned child.
			pendingData.push(chunk.slice());
			return;
		}
		for (const handler of dataHandlers) {
			try {
				handler(chunk);
			} catch {
				// ignore handler errors
			}
		}
	};

	const finalize = () => {
		if (finalized || !terminalClosed || !processExit) return;
		finalized = true;
		for (const handler of exitHandlers) {
			try {
				handler(processExit.exitCode, processExit.signal, processExit.failureMessage);
			} catch {
				// ignore handler errors
			}
		}
		exitHandlers.clear();
		dataHandlers.clear();
	};

	const child = runtime.spawn([file, ...args], {
		cwd: opts.cwd,
		// The child talks to this PTY's xterm emulator, never to omp's own terminal.
		env: { ...opts.env, TERM: "xterm-256color" },
		windowsVerbatimArguments: opts.windowsVerbatimArguments,
		terminal: {
			name: "xterm-256color",
			cols: opts.cols ?? DEFAULT_PTY_COLS,
			rows: opts.rows ?? DEFAULT_PTY_ROWS,
			data(activeTerminal, chunk) {
				terminal = activeTerminal;
				emitData(chunk);
			},
			exit(activeTerminal) {
				terminal = activeTerminal;
				terminalClosed = true;
				finalize();
			},
		},
		onExit(subprocess, exitCode, signalCode, error) {
			processExited = true;
			terminal = subprocess.terminal ?? terminal;
			const signal = bunSignalName(signalCode);
			processExit = {
				exitCode: signal ? null : exitCode,
				signal,
				...(error ? { failureMessage: `process error: ${error.message}` } : {}),
			};
			if (terminal?.closed) terminalClosed = true;
			finalize();
		},
	});
	terminal = child.terminal;
	if (!terminal) throw new Error("Bun.spawn did not return a terminal");

	return {
		pid: child.pid,
		get processExited() {
			return processExited;
		},
		write(data) {
			const activeTerminal = terminal;
			if (finalized || processExited || !activeTerminal || activeTerminal.closed) return false;
			try {
				activeTerminal.write(data);
				return true;
			} catch {
				return false;
			}
		},
		onData(handler) {
			bufferingInitialData = false;
			for (const chunk of pendingData) {
				try {
					handler(chunk);
				} catch {
					// ignore handler errors
				}
			}
			pendingData = [];
			if (finalized) return () => {};
			dataHandlers.add(handler);
			return () => dataHandlers.delete(handler);
		},
		onExit(handler) {
			if (finalized) {
				const exit = processExit;
				if (!exit) return;
				try {
					handler(exit.exitCode, exit.signal, exit.failureMessage);
				} catch {
					// ignore handler errors
				}
				return;
			}
			exitHandlers.add(handler);
		},
		kill(signal = "SIGTERM") {
			if (processExited) return;
			if (IS_WINDOWS) {
				killWindowsTree(child.pid);
				return;
			}
			killPosixProcessGroup(child.pid, signal);
		},
	};
}

