import { randomBytes } from "node:crypto";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { CollectResult } from "./collect.ts";
import type { OnExitPolicy } from "./completion.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import type { TerminalObservation, TerminalScreenKind, TerminalView } from "./terminal-screen.ts";

export type ProcessOperation = "exec_command" | "write_stdin";
export type ProcessStatus = "running" | "exited";
export type KillStatus = "killed" | "kill_failed";

/** Fields shared by every result that carries child-process output. */
export interface OutputResultDetails {
	operation: ProcessOperation | "kill_session";
	status: ProcessStatus | KillStatus;
	running: boolean;
	chunk_id: string;
	wall_time_seconds: number;
	/** Bounded, terminal-inert tail sent to the model and used by the TUI renderer. */
	output: string;
	original_token_count?: number;
	session_id?: number;
	exit_code?: number;
	signal?: string;
	failure_message?: string;
	log_path?: string;
	/** Non-consuming retained terminal projection. */
	terminal_url?: string;
	cwd?: string;
	/** Shell executable selected when the session was spawned. */
	shell?: string;
	command?: string;
	truncation?: TruncationResult;
	/** Cumulative bytes this session has produced since spawn. */
	output_bytes_total?: number;
	/** Optional explanation of an unusual session state (e.g. shell exited but the terminal is still held open). */
	note?: string;
	/** How `output` relates to the session's terminal screen. */
	terminal?: TerminalDetails;
}

/** Geometry is shared; only running observations carry incremental metadata. */
interface TerminalGeometryDetails {
	screen: TerminalScreenKind;
	cols: number;
	rows: number;
	/** 1-based cursor position within the screen. */
	cursor_row: number;
	cursor_col: number;
}

export interface IncrementalTerminalDetails extends TerminalGeometryDetails {
	screen_changed: boolean;
	history_lines?: number;
	/** Rows that scrolled off since the previous call were evicted from the capped history before being reported; they are only in the log. */
	history_may_be_truncated?: true;
}

export interface FinalTerminalDetails extends TerminalGeometryDetails {
	retained_rows: number;
	/** The retained normal-screen history may have reached the emulator's cap. */
	history_may_be_truncated: boolean;
}

export type TerminalDetails = IncrementalTerminalDetails | FinalTerminalDetails;

export interface ProcessResultDetails extends OutputResultDetails {
	operation: ProcessOperation;
	status: ProcessStatus;
	yield_time_ms?: number;
	wait_mode?: "relative" | "absolute";
	wait_status?: "completed" | "relative_deadline_reached" | "absolute_deadline_reached" | "cancelled";
	yield_until?: string;
	effective_wait_ms?: number;
	on_exit?: OnExitPolicy;
	completion_notification?: "armed";
	completion_delivery?: "direct";
	on_exit_wake?: "consumed";
	tool_time_utc?: string;
}

export interface KillResultDetails extends OutputResultDetails {
	operation: "kill_session";
	status: KillStatus;
	found: true;
	session_id: number;
	pid?: number;
	requested_signal: string;
	killed: boolean;
	escalated: boolean;
}

interface OutputEnvelopeInput {
	wallTimeSec: number;
	/** The session's terminal observation this call, or nothing. */
	collected: CollectResult;
	logPath?: string;
	/** Cumulative bytes the session has produced since spawn. */
	totalBytes?: number;
}

export interface FinalizeProcessInput extends OutputEnvelopeInput {
	operation: ProcessOperation;
	sessionId: number | undefined;
	exitCode: number | null | undefined;
	signal: NodeJS.Signals | null;
	failure: string | null;
	cwd?: string;
	shell?: string;
	command?: string;
	yieldTimeMs?: number;
	/** Long-wait / wake metadata merged into the result (undefined values skipped). */
	extra?: Partial<ProcessResultDetails>;
}

export interface FinalizeKillInput extends OutputEnvelopeInput {
	sessionId: number;
	pid?: number;
	requestedSignal: NodeJS.Signals;
	exitCode: number | null | undefined;
	signal: NodeJS.Signals | null;
	failure: string | null;
	cwd?: string;
	shell?: string;
	command?: string;
	escalated: boolean;
	killed: boolean;
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function approxTokenCount(byteLength: number): number {
	// Mirror codex's rough `approx_token_count` behaviour: 4 bytes ≈ 1 token.
	return Math.ceil(byteLength / 4);
}

export function safeMeta(value: string, max = 4096): string {
	// Metadata sits outside the 50 KiB child-output body. Bound both the scan and
	// rendered value so a malformed path/error cannot recreate an oversized
	// result through a header field.
	const scanLimit = max * 8;
	let end = Math.min(value.length, scanLimit);
	if (end < value.length && end > 0 && /[\ud800-\udbff]/.test(value[end - 1]!)) end--;
	const clipped = end < value.length;
	const clean = sanitizeOutputText(value.slice(0, end)).replace(/\s+/g, " ").trim();
	if (!clipped && clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

type OutputEnvelope = Pick<
	OutputResultDetails,
	| "chunk_id"
	| "wall_time_seconds"
	| "output"
	| "original_token_count"
	| "log_path"
	| "truncation"
	| "output_bytes_total"
	| "terminal"
	| "terminal_url"
>;

function createOutputEnvelope(input: OutputEnvelopeInput): OutputEnvelope {
	const collected = input.collected;
	let text: string;
	let byteLength: number;
	switch (collected.kind) {
		case "none":
			text = "";
			byteLength = 0;
			break;
		case "screen": {
			const observation = collected.observation;
			text = observation.kind === "rendered" ? sanitizeOutputText(observation.text) : "";
			byteLength = Buffer.byteLength(text, "utf8");
			break;
		}
		case "final-screen":
			text = sanitizeOutputText(collected.projection.screenLines.join("\n"));
			byteLength = Buffer.byteLength(text, "utf8");
			break;
	}
	const truncation = truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const envelope: OutputEnvelope = {
		chunk_id: generateChunkId(),
		wall_time_seconds: input.wallTimeSec,
		output: truncation.content,
		original_token_count: approxTokenCount(byteLength),
	};
	if (input.logPath) envelope.log_path = input.logPath;
	if (collected.kind === "screen") envelope.terminal = terminalDetails(collected.observation);
	if (collected.kind === "final-screen") {
		const { projection } = collected;
		envelope.terminal = {
			screen: projection.view.screen,
			cols: projection.view.cols,
			rows: projection.view.rows,
			cursor_row: projection.view.cursor.row,
			cursor_col: projection.view.cursor.col,
			retained_rows: projection.retainedLines.length,
			history_may_be_truncated: projection.historyMayBeTruncated,
		};
	}
	if (collected.kind !== "none" && collected.terminalUrl) envelope.terminal_url = collected.terminalUrl;
	if (input.totalBytes !== undefined) envelope.output_bytes_total = input.totalBytes;
	if (truncation.truncated) envelope.truncation = truncation;
	return envelope;
}

/** Terminal metadata for a full rendered screen (also used by live streaming snapshots). */
export function terminalViewDetails(view: TerminalView, screenChanged: boolean): IncrementalTerminalDetails {
	return {
		screen: view.screen,
		cols: view.cols,
		rows: view.rows,
		cursor_row: view.cursor.row,
		cursor_col: view.cursor.col,
		screen_changed: screenChanged,
	};
}

function terminalDetails(observation: TerminalObservation): IncrementalTerminalDetails {
	const details = terminalViewDetails(observation.view, observation.kind === "rendered");
	if (observation.kind === "rendered") {
		if (observation.historyLines > 0) details.history_lines = observation.historyLines;
		if (observation.historyMayBeTruncated) details.history_may_be_truncated = true;
	}
	return details;
}

/** Header lines describing the terminal output, shared by process and kill results. */
function terminalLines(terminal: TerminalDetails | undefined): string[] {
	if (!terminal) return [];
	const lines = [
		`terminal: ${terminal.screen} screen ${terminal.cols}x${terminal.rows}, cursor row ${terminal.cursor_row} col ${terminal.cursor_col}`,
	];
	if ("retained_rows" in terminal) {
		lines.push(`retained_rows: ${terminal.retained_rows}`);
		lines.push(`history_may_be_truncated: ${terminal.history_may_be_truncated}`);
	} else {
		if (!terminal.screen_changed) lines.push("screen_changed: false");
		if (terminal.history_lines) lines.push(`history_lines: ${terminal.history_lines}`);
		if (terminal.history_may_be_truncated) lines.push("history_may_be_truncated: true");
	}
	return lines;
}

export function finalizeProcessResult(input: FinalizeProcessInput): ProcessResultDetails {
	const envelope = createOutputEnvelope(input);
	const running = input.sessionId !== undefined;
	const shape: ProcessResultDetails = {
		...envelope,
		operation: input.operation,
		status: running ? "running" : "exited",
		running,
	};
	if (input.sessionId !== undefined) shape.session_id = input.sessionId;
	if (input.exitCode !== undefined && input.exitCode !== null) shape.exit_code = input.exitCode;
	if (input.signal) shape.signal = input.signal;
	if (input.failure) shape.failure_message = input.failure;
	if (input.cwd) shape.cwd = input.cwd;
	if (input.shell) shape.shell = input.shell;
	if (input.command) shape.command = input.command;
	if (input.yieldTimeMs) shape.yield_time_ms = input.yieldTimeMs;
	if (input.extra) {
		for (const [key, value] of Object.entries(input.extra)) {
			if (value !== undefined) (shape as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return shape;
}

export function finalizeKillResult(input: FinalizeKillInput): KillResultDetails {
	const envelope = createOutputEnvelope(input);
	const shape: KillResultDetails = {
		...envelope,
		operation: "kill_session",
		status: input.killed ? "killed" : "kill_failed",
		running: !input.killed,
		found: true,
		session_id: input.sessionId,
		requested_signal: input.requestedSignal,
		killed: input.killed,
		escalated: input.escalated,
	};
	if (input.pid !== undefined) shape.pid = input.pid;
	if (input.exitCode !== undefined && input.exitCode !== null) shape.exit_code = input.exitCode;
	if (input.signal) shape.signal = input.signal;
	if (input.failure) shape.failure_message = input.failure;
	if (input.cwd) shape.cwd = input.cwd;
	if (input.shell) shape.shell = input.shell;
	if (input.command) shape.command = input.command;
	return shape;
}

/** Pi-bash-style marker appended to model-visible text after a truncated body. */
export function truncationMarker(t: TruncationResult | undefined, logPath: string | undefined): string | null {
	if (!t?.truncated) return null;
	const full = logPath ? `. Full output: ${safeMeta(logPath)}` : "";
	if (t.lastLinePartial) {
		return `[Showing last ${formatSize(t.outputBytes)} of final line (line ${t.totalLines} is larger than the ${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
	}
	const startLine = t.totalLines - t.outputLines + 1;
	const endLine = t.totalLines;
	if (t.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${t.totalLines}${full}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
}

function appendOutputSection(lines: string[], shape: OutputResultDetails): string {
	const header = lines.join("\n");
	const body = shape.output || "(no output)";
	const marker = truncationMarker(shape.truncation, shape.log_path);
	const footer = marker ? `\n\n${marker}` : "";
	return `${header}\n---\n${body}${footer}`;
}

export function renderProcessResultText(shape: ProcessResultDetails): string {
	const lines: string[] = [shape.running ? "[still running]" : "[exited]"];
	if (shape.session_id !== undefined) lines.push(`session_id: ${shape.session_id}`);
	if (shape.exit_code !== undefined) lines.push(`exit_code: ${shape.exit_code}`);
	if (shape.signal) lines.push(`signal: ${safeMeta(shape.signal)}`);
	if (shape.failure_message) lines.push(`failure: ${safeMeta(shape.failure_message)}`);
	if (shape.note) lines.push(`note: ${safeMeta(shape.note)}`);
	if (shape.wait_mode) lines.push(`wait_mode: ${safeMeta(shape.wait_mode)}`);
	if (shape.wait_status) lines.push(`wait_status: ${safeMeta(shape.wait_status)}`);
	if (shape.yield_until) lines.push(`yield_until: ${safeMeta(shape.yield_until)}`);
	if (shape.effective_wait_ms !== undefined) lines.push(`effective_wait_ms: ${shape.effective_wait_ms}`);
	if (shape.on_exit) lines.push(`on_exit: ${safeMeta(shape.on_exit)}`);
	if (shape.completion_notification) lines.push(`completion_notification: ${safeMeta(shape.completion_notification)}`);
	if (shape.completion_delivery) lines.push(`completion_delivery: ${safeMeta(shape.completion_delivery)}`);
	if (shape.on_exit_wake) lines.push(`on_exit_wake: ${safeMeta(shape.on_exit_wake)}`);
	if (shape.tool_time_utc) lines.push(`tool_time_utc: ${safeMeta(shape.tool_time_utc)}`);
	if (shape.log_path) lines.push(`log_path: ${safeMeta(shape.log_path)}`);
	if (shape.terminal_url) lines.push(`terminal_url: ${safeMeta(shape.terminal_url)}`);
	if (shape.cwd) lines.push(`cwd: ${safeMeta(shape.cwd)}`);
	if (shape.shell) lines.push(`shell: ${safeMeta(shape.shell)}`);
	lines.push(`wall_time_seconds: ${shape.wall_time_seconds.toFixed(3)}`);
	lines.push(`chunk_id: ${shape.chunk_id}`);
	if (shape.original_token_count !== undefined) lines.push(`original_token_count: ${shape.original_token_count}`);
	if (shape.output_bytes_total !== undefined) lines.push(`output_bytes_total: ${shape.output_bytes_total}`);
	lines.push(...terminalLines(shape.terminal));
	return appendOutputSection(lines, shape);
}

export function renderKillResultText(shape: KillResultDetails): string {
	const lines: string[] = [shape.killed ? "[killed]" : "[kill failed]"];
	lines.push(`session_id: ${shape.session_id}`);
	if (shape.pid !== undefined) lines.push(`pid: ${shape.pid}`);
	lines.push(`requested_signal: ${safeMeta(shape.requested_signal)}`);
	lines.push(`killed: ${shape.killed}`);
	lines.push(`running: ${shape.running}`);
	lines.push(`escalated: ${shape.escalated}`);
	if (shape.exit_code !== undefined) lines.push(`exit_code: ${shape.exit_code}`);
	if (shape.signal) lines.push(`signal: ${safeMeta(shape.signal)}`);
	if (shape.failure_message) lines.push(`failure: ${safeMeta(shape.failure_message)}`);
	if (shape.log_path) lines.push(`log_path: ${safeMeta(shape.log_path)}`);
	if (shape.terminal_url) lines.push(`terminal_url: ${safeMeta(shape.terminal_url)}`);
	if (shape.cwd) lines.push(`cwd: ${safeMeta(shape.cwd)}`);
	if (shape.shell) lines.push(`shell: ${safeMeta(shape.shell)}`);
	lines.push(`wall_time_seconds: ${shape.wall_time_seconds.toFixed(3)}`);
	lines.push(`chunk_id: ${shape.chunk_id}`);
	if (shape.original_token_count !== undefined) lines.push(`original_token_count: ${shape.original_token_count}`);
	if (shape.output_bytes_total !== undefined) lines.push(`output_bytes_total: ${shape.output_bytes_total}`);
	lines.push(...terminalLines(shape.terminal));
	return appendOutputSection(lines, shape);
}
