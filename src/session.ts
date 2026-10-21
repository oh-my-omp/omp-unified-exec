/**
 * ExecSession — wraps a PTY SpawnedChild with:
 *   - a TerminalScreen that renders the child's output as a terminal shows
 *     it (observed by polls, snapshotted for TUI streaming)
 *   - a log file mirroring every raw byte
 *   - state transitions (has_exited / exit_code / signal / failure)
 *   - lifecycle callbacks (onExit fan-out, monitor subscriptions)
 *
 * Mirrors codex's `UnifiedExecProcess` in `unified_exec/process.rs`, simplified
 * to the subset we need for the pi extension.
 */

import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discardLiveTerminal, freezeTerminal, readTerminal, registerTerminal } from "../fork-features/terminal-resource.ts";
import type { MonitorListener, MonitorSourceHandle, MonitorStart } from "../fork-features/monitor-subscription.ts";
import { type CollectResult, type FinalScreenOutput, NO_OUTPUT, type NoOutput } from "./collect.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { Gate, Notify } from "./notify.ts";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, type SpawnedChild, spawnChild } from "./pty.ts";
import { type StyledScreen, type TerminalAppearance, TerminalScreen, type TerminalSnapshot } from "./terminal-screen.ts";

export interface SessionSpawnOptions {
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	displayCommand?: string; // human-readable command for list_sessions/UI
	windowsVerbatimArguments?: boolean; // Windows cmd.exe quoting (see shell.ts)
	/** The background the session's screen is shown on (default dark), answered to OSC 10/11. */
	appearance?: () => TerminalAppearance;
}

export interface SessionState {
	hasExited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failureMessage: string | null;
	/** Epoch ms the session was marked exited; null while running. */
	exitedAt: number | null;
}

export class ExecSession {
	readonly id: number;
	readonly command: string[];
	/** Executable actually passed to spawn, not a later host-setting lookup. */
	get shell(): string | undefined {
		return this.command[0];
	}
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly pid: number | undefined;
	/** Path to a log file that receives the full stdout+stderr stream. */
	readonly logPath: string;
	private logStream: WriteStream | undefined;

	/** Rendered terminal; created once the PTY child exists (absent after a spawn failure). */
	private screen: TerminalScreen | undefined;
	private terminalKey: string | undefined;
	private terminalFinalized: Promise<void> | undefined;
	/** Fired whenever the child produces output. */
	readonly outputNotify = new Notify();
	/** Closed when the stream is done (all data flushed after exit). */
	readonly outputClosed = new Gate();
	/** Aborts when the process has exited (may still have trailing output). */
	private readonly exitedAc = new AbortController();
	get exited(): AbortSignal {
		return this.exitedAc.signal;
	}

	private totalOutputBytes = 0;

	private state: SessionState = {
		hasExited: false,
		exitCode: null,
		signal: null,
		failureMessage: null,
		exitedAt: null,
	};
	private readonly exitListeners = new Set<(session: ExecSession) => void>();
	private lastUsedAt: number;
	private child!: SpawnedChild;

	private constructor(id: number, opts: SessionSpawnOptions) {
		this.id = id;
		this.command = opts.command;
		this.displayCommand = opts.displayCommand ?? opts.command.join(" ");
		this.cwd = opts.cwd;
		this.startedAt = Date.now();
		this.lastUsedAt = this.startedAt;
		this.pid = undefined; // set in `start`
		this.logPath = join(tmpdir(), `pi-unified-exec-${id}-${randomBytes(4).toString("hex")}.log`);
	}

	static spawn(id: number, opts: SessionSpawnOptions): ExecSession {
		const self = new ExecSession(id, opts);

		// Touch-create the file synchronously so it exists on disk from t=0
		// even before the child writes anything (and before the lazy stream
		// opens the fd on its first buffered write). Then open a stream in
		// append mode for the actual writes.
		try {
			closeSync(openSync(self.logPath, "w"));
			self.logStream = createWriteStream(self.logPath, { flags: "a" });
			self.logStream.on("error", (err) => {
				// Log-stream error (disk full, permissions, etc.). The child is
				// still running: record the failure and stop mirroring writes, but
				// do NOT mark the session exited — that would make it unkillable
				// (kill() no-ops once hasExited) and orphan the process.
				self.recordFailure(`log stream error: ${err?.message ?? err}`);
				self.logStream = undefined;
			});
		} catch (err: any) {
			self.markFailure(`failed to open log file ${self.logPath}: ${err?.message ?? err}`);
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}

		const cols = opts.cols ?? DEFAULT_PTY_COLS;
		const rows = opts.rows ?? DEFAULT_PTY_ROWS;
		try {
			self.child = spawnChild({
				command: opts.command,
				cwd: opts.cwd,
				env: opts.env,
				cols,
				rows,
				windowsVerbatimArguments: opts.windowsVerbatimArguments,
			});
		} catch (err: any) {
			self.markFailure(err?.message ?? String(err));
			self.logStream?.end();
			self.logStream = undefined;
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}

		// child's actual pid
		Object.defineProperty(self, "pid", { value: self.child.pid, enumerable: true });

		// A real terminal answers queries (cursor position, device attributes);
		// a child that waits for the answer would otherwise stall.
		const screen = new TerminalScreen(cols, rows, (reply) => void self.write(reply), opts.appearance);
		self.screen = screen;
		const key = registerTerminal(id, screen);
		self.terminalKey = key;
		// The output gate closes after the final child bytes and log flush.
		// freezeTerminal then waits for parsing without consuming observation.
		self.terminalFinalized = self.outputClosed.closed().then(() => freezeTerminal(key));

		self.child.onData((chunk) => {
			self.totalOutputBytes += chunk.length;
			screen.write(chunk);
			// Mirror every byte to the log file. Errors are handled by the
			// 'error' listener on the stream, which nulls `logStream` out.
			self.logStream?.write(Buffer.from(chunk));
			self.outputNotify.notifyAll();
		});

		self.child.onExit((exitCode, signal, failureMessage) => {
			self.state = {
				hasExited: true,
				exitCode,
				signal,
				failureMessage: self.state.failureMessage ?? failureMessage ?? null,
				exitedAt: Date.now(),
			};
			self.exitedAc.abort();
			self.notifyExitListeners();
			// Fire a notify so any parked waiters wake up and see the exit.
			self.outputNotify.notifyAll();
			// A short tick later, flush the log stream to disk, then close the
			// output gate. The tick lets any pending data-handler chunks land
			// in the screen+log before we declare the session fully done.
			setImmediate(() => {
				self.outputNotify.notifyAll();
				const stream = self.logStream;
				self.logStream = undefined;
				if (!stream) {
					self.outputClosed.close();
					self.outputNotify.notifyAll();
					return;
				}
				const finalize = () => {
					self.outputClosed.close();
					self.outputNotify.notifyAll();
				};
				// Wait for the stream to finish flushing before declaring
				// `outputClosed` so consumers that await the drain see a
				// fully-flushed log file on disk.
				stream.once("close", finalize);
				stream.end();
			});
		});

		return self;
	}

	/**
	 * Record a non-fatal failure (e.g. log mirroring broke) WITHOUT marking the
	 * session exited. The child keeps running and stays controllable.
	 */
	private recordFailure(message: string): void {
		this.state = {
			...this.state,
			failureMessage: this.state.failureMessage ?? message,
		};
	}

	/** Mark the session as failed-and-exited. Only for spawn-time failures. */
	private markFailure(message: string): void {
		this.state = {
			hasExited: true,
			exitCode: this.state.exitCode,
			signal: this.state.signal,
			failureMessage: message,
			exitedAt: Date.now(),
		};
		this.notifyExitListeners();
	}

	private notifyExitListeners(): void {
		for (const listener of this.exitListeners) {
			try {
				listener(this);
			} catch {
				// ignore listener failures
			}
		}
	}

	/** Register a listener fired when this session exits. */
	onExit(listener: (session: ExecSession) => void): () => void {
		this.exitListeners.add(listener);
		if (this.hasExited) {
			queueMicrotask(() => {
				if (this.exitListeners.has(listener)) listener(this);
			});
		}
		return () => this.exitListeners.delete(listener);
	}

	/** What a streaming update shows now, without consuming anything (undefined after a spawn failure). */
	liveSnapshot(): TerminalSnapshot | undefined {
		return this.screen?.snapshot();
	}

	/** The screen with styling for live display (undefined after a spawn failure); consumes nothing. */
	styledScreen(): StyledScreen | undefined {
		return this.screen?.styledScreen();
	}

	/** Call `listener` whenever new output has been parsed into the screen; returns the unsubscribe. */
	onScreenChange(listener: () => void): () => void {
		return this.screen?.onChange(listener) ?? (() => {});
	}

	/** Establish on the source's boundary; no replay and no speculative subscription. */
	async subscribeMonitor(
		listener: MonitorListener,
		accept: (handle: MonitorSourceHandle) => boolean,
		signal?: AbortSignal,
	): Promise<MonitorStart> {
		if (signal?.aborted) return "cancelled";
		const screen = this.screen;
		if (this.hasExited || !screen) return "not_running";
		if (listener.conditional) {
			return screen.subscribeLines(() => !this.hasExited, (lines) => listener.lines(lines), (handle) => {
				// Register final draining before publishing the subscription. The
				// gate's freeze callback already queued its projection; this queues
				// the monitor drain before any release awaiting that freeze.
				const unsubscribeClose = this.outputClosed.subscribe(async () => {
					if (await handle.finish()) listener.end();
				});
				const source: MonitorSourceHandle = {
					cancel: () => { unsubscribeClose(); handle.cancel(); },
				};
				try {
					if (!accept(source)) { source.cancel(); return false; }
					return true;
				} catch (error) {
					source.cancel();
					throw error;
				}
			}, signal);
		}
		let active = true;
		const handle: MonitorSourceHandle = {
			cancel: () => {
				active = false;
				unsubscribeClose();
			},
		};
		const unsubscribeClose = this.outputClosed.subscribe(async () => {
			await this.terminalFinalized;
			if (!active) return;
			handle.cancel();
			listener.end();
		});
		try {
			if (!accept(handle)) { handle.cancel(); return "cancelled"; }
		} catch (error) {
			handle.cancel();
			throw error;
		}
		return "accepted";
	}

	/**
	 * Wait until `deadlineMs` (or exit/abort). A running session then consumes
	 * an observation of its screen; a completed session returns its immutable
	 * final active screen. A session whose live terminal was already released
	 * (shutdown does not wait for the process to die) has nothing to observe.
	 */
	async collect(opts: { deadlineMs: number; externalAbort?: AbortSignal }): Promise<CollectResult> {
		await waitForExitOrDeadline({
			exited: this.exited,
			externalAbort: opts.externalAbort,
			durationMs: opts.deadlineMs - Date.now(),
		});
		if (this.hasExited) return this.finalScreenOutput();
		const screen = this.screen;
		if (!screen) return NO_OUTPUT;
		const observation = await screen.observe();
		// Exit may land while the observation's parser barrier is pending.
		if (this.hasExited) return this.finalScreenOutput();
		return { kind: "screen", observation, terminalUrl: this.terminalUrl };
	}

	/** The frozen final screen, or nothing when shutdown discarded the unfinished terminal. */
	private async finalScreenOutput(): Promise<FinalScreenOutput | NoOutput> {
		await this.terminalFinalized;
		const key = this.terminalKey;
		if (key === undefined) return NO_OUTPUT;
		return { kind: "final-screen", projection: await readTerminal(key), terminalUrl: `term://${key}` };
	}

	get terminalUrl(): string | undefined {
		return this.terminalKey === undefined ? undefined : `term://${this.terminalKey}`;
	}

	/** Normal removal waits for output closure and the one session-owned freeze. */
	async release(): Promise<void> {
		await this.terminalFinalized;
		await this.detachScreen()?.release();
	}

	/** Shutdown need not retain an unfinished projection; completed resources survive. */
	async releaseForShutdown(): Promise<void> {
		if (this.terminalKey !== undefined && discardLiveTerminal(this.terminalKey)) this.terminalKey = undefined;
		await this.detachScreen()?.release();
	}

	/**
	 * End the session's ownership of its screen. Observations already queued
	 * on the screen still run before its release; later callers see no screen.
	 */
	private detachScreen(): TerminalScreen | undefined {
		const screen = this.screen;
		this.screen = undefined;
		return screen;
	}

	/** Write bytes to the PTY input. Returns true on success, false if closed/dead. */
	write(data: Uint8Array): boolean {
		if (this.state.hasExited) return false;
		return this.child.write(data);
	}

	/** Send a signal. No-op if already exited. */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.state.hasExited) return;
		this.child.kill(signal);
	}

	get hasExited(): boolean {
		return this.state.hasExited;
	}

	/**
	 * The shell process itself has exited. This can be true while
	 * `hasExited` is still false: a descendant that survives the shell's exit
	 * (e.g. a SIGHUP-immune background job) still holds the PTY, so the
	 * terminal-close-based session exit lags (or never arrives). Lets callers
	 * explain a session that reports "running" although its shell is gone.
	 */
	get shellExited(): boolean {
		return this.child.processExited;
	}

	get exitCode(): number | null {
		return this.state.exitCode;
	}

	get signal(): NodeJS.Signals | null {
		return this.state.signal;
	}

	get failureMessage(): string | null {
		return this.state.failureMessage;
	}

	/** Epoch ms the session was marked exited; null while running. */
	get exitedAt(): number | null {
		return this.state.exitedAt;
	}

	get totalBytesSeen(): number {
		return this.totalOutputBytes;
	}

	get lastUsed(): number {
		return this.lastUsedAt;
	}

	touch(): void {
		this.lastUsedAt = Date.now();
	}

	/** Terminate + mark closed. Used by session-store LRU eviction / shutdown. */
	terminate(signal: NodeJS.Signals = "SIGTERM"): void {
		this.kill(signal);
		// onExit closes logStream; terminate() is idempotent so this is fine.
	}
}
