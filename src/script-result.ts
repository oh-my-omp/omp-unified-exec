/**
 * Structured tool results matching each tool's `outputSchema`.
 *
 * `structuredContent` exposes `output` as a real multi-line string plus
 * typed state (`exit_code`, `session_id`, …). They derive only from the
 * already-bounded, sanitized result details, so they add no new size or
 * terminal-safety surface. Model-visible `content` and persisted `details`
 * are unchanged.
 */

import { Type, type Static } from "typebox";

import type { OnExitPolicy } from "./completion.ts";
import type { MonitorStatus } from "../fork-features/monitor-subscription.ts";
import { type KillResultDetails, type ProcessResultDetails, safeMeta } from "./tool-result.ts";

const optionalMeta = (value: string | undefined): string | undefined => (value ? safeMeta(value) : undefined);

/** Drop undefined fields so the value is plain JSON. */
function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

const terminalGeometryFields = {
	screen: Type.Union([Type.Literal("normal"), Type.Literal("alternate")]),
	cols: Type.Number(),
	rows: Type.Number(),
	cursor_row: Type.Number({ description: "1-based cursor row within the screen." }),
	cursor_col: Type.Number({ description: "1-based cursor column." }),
};

const terminalSchema = Type.Union([
	Type.Object({
		...terminalGeometryFields,
		screen_changed: Type.Boolean({ description: "False when the running screen is exactly as last reported (output is empty)." }),
		history_lines: Type.Optional(
			Type.Number({ description: "Leading output lines that scrolled off above the screen since the last call." }),
		),
		history_may_be_truncated: Type.Optional(Type.Literal(true)),
	}, { description: "Running observation: unseen history followed by the current screen." }),
	Type.Object({
		...terminalGeometryFields,
		retained_rows: Type.Number({ description: "Normal-screen physical rows retained at freeze, not total output rows." }),
		history_may_be_truncated: Type.Boolean(),
	}, { description: "Completed result: only the final active screen; recover retained history through terminal_url." }),
]);

const outputFields = {
	output: Type.String({
		description:
			"Bounded, terminal-safe text of the session's rendered screen with real newlines. Print it with text(r.output) rather than printing the whole result object.",
	}),
	truncated: Type.Boolean({ description: "True when earlier output was (or may have been) dropped; the full stream is in log_path." }),
	exit_code: Type.Optional(Type.Number({ description: "Exit code once the process has exited." })),
	signal: Type.Optional(Type.String({ description: "Signal that terminated the process, if any." })),
	failure_message: Type.Optional(Type.String()),
	shell: Type.Optional(Type.String({ description: "Actual shell executable selected at process initialization." })),
	log_path: Type.Optional(Type.String({ description: "File containing the complete output stream." })),
	terminal_url: Type.Optional(Type.String({ description: "Non-consuming term:// terminal projection; readable after exit." })),
	wall_time_seconds: Type.Number(),
	terminal: Type.Optional(terminalSchema),
};

function wasTruncated(shape: ProcessResultDetails | KillResultDetails): boolean {
	return shape.truncation?.truncated === true || shape.terminal?.history_may_be_truncated === true;
}

export const processScriptResultSchema = Type.Object({
	status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
	running: Type.Boolean(),
	session_id: Type.Optional(
		Type.Number({ description: "Present while the process is still running; read terminal_url for state/content, use monitor for events or completion, and write_stdin for input." }),
	),
	...outputFields,
	note: Type.Optional(Type.String()),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
	tool_time_utc: Type.Optional(Type.String({ description: "Current host UTC time." })),
});
export type ProcessScriptResult = Static<typeof processScriptResultSchema>;

export function processScriptResult(shape: ProcessResultDetails): ProcessScriptResult {
	return compact({
		status: shape.status,
		running: shape.running,
		session_id: shape.session_id,
		output: shape.output,
		truncated: wasTruncated(shape),
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		shell: optionalMeta(shape.shell),
		log_path: optionalMeta(shape.log_path),
		terminal_url: shape.terminal_url,
		wall_time_seconds: shape.wall_time_seconds,
		terminal: shape.terminal,
		note: optionalMeta(shape.note),
		on_exit: shape.on_exit,
		tool_time_utc: shape.tool_time_utc,
	});
}

export const killScriptResultSchema = Type.Object({
	status: Type.Union([Type.Literal("killed"), Type.Literal("kill_failed")]),
	found: Type.Boolean({ description: "False when no session had this id." }),
	killed: Type.Boolean(),
	running: Type.Boolean({ description: "True when the kill was not confirmed and the session remains registered." }),
	escalated: Type.Boolean({ description: "True when SIGKILL escalation was needed." }),
	session_id: Type.Number(),
	...outputFields,
});
export type KillScriptResult = Static<typeof killScriptResultSchema>;

export function killScriptResult(shape: KillResultDetails): KillScriptResult {
	return compact({
		status: shape.status,
		found: true,
		killed: shape.killed,
		running: shape.running,
		escalated: shape.escalated,
		session_id: shape.session_id,
		output: shape.output,
		truncated: wasTruncated(shape),
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		shell: optionalMeta(shape.shell),
		log_path: optionalMeta(shape.log_path),
		terminal_url: shape.terminal_url,
		wall_time_seconds: shape.wall_time_seconds,
		terminal: shape.terminal,
	});
}

export function killNotFoundScriptResult(sessionId: number): KillScriptResult {
	return {
		status: "kill_failed",
		found: false,
		killed: false,
		running: false,
		escalated: false,
		session_id: sessionId,
		output: "",
		truncated: false,
		wall_time_seconds: 0,
	};
}

export const setOnExitScriptResultSchema = Type.Object({
	session_id: Type.Number(),
	found: Type.Boolean({ description: "False when no session or pending wake had this id." }),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
	status: Type.Optional(Type.String()),
	running: Type.Optional(Type.Boolean()),
	wake_armed: Type.Optional(Type.Boolean()),
});
export type SetOnExitScriptResult = Static<typeof setOnExitScriptResultSchema>;

export function setOnExitScriptResult(value: {
	session_id: number;
	found: boolean;
	on_exit?: OnExitPolicy;
	status?: string;
	running?: boolean;
	wake_armed?: boolean;
}): SetOnExitScriptResult {
	return compact({ ...value });
}

const monitorStatusSchema = Type.Object({
	condition: Type.Union([Type.String(), Type.Null()]),
	returns: Type.Number(),
	max_returns: Type.Number(),
	remind_after_ms: Type.Number(),
});

export const monitorScriptResultSchema = Type.Union([
	Type.Object({ session_id: Type.Number(), status: Type.Literal("started"), monitor: monitorStatusSchema }),
	Type.Object({ session_id: Type.Number(), status: Type.Union([Type.Literal("cancelled"), Type.Literal("not_monitored")]) }),
	Type.Object({ session_id: Type.Number(), status: Type.Literal("error"), code: Type.String(), message: Type.String() }),
]);
export type MonitorScriptResult = Static<typeof monitorScriptResultSchema>;

export const listSessionsScriptResultSchema = Type.Object({
	sessions: Type.Array(
		Type.Object({
			session_id: Type.Number(),
			command: Type.String(),
			cwd: Type.Optional(Type.String()),
			shell: Type.Optional(Type.String()),
			pid: Type.Optional(Type.Number()),
			elapsed_ms: Type.Number(),
			running: Type.Boolean({ description: "False for sessions that just exited; they are removed after this listing." }),
			wake_armed: Type.Boolean(),
			monitor: Type.Optional(monitorStatusSchema),
			exit_code: Type.Optional(Type.Number()),
			signal: Type.Optional(Type.String()),
			log_path: Type.Optional(Type.String()),
			terminal_url: Type.Optional(Type.String()),
		}),
	),
	active_count: Type.Number(),
	just_exited_count: Type.Number(),
	tool_time_utc: Type.String(),
});
export type ListSessionsScriptResult = Static<typeof listSessionsScriptResultSchema>;

export function listSessionsScriptResult(value: {
	sessions: ReadonlyArray<{
		session_id: number;
		command: string;
		cwd?: string;
		shell?: string;
		pid?: number;
		elapsed_ms: number;
		running: boolean;
		wake_armed: boolean;
		monitor?: MonitorStatus;
		exit_code?: number | null;
		signal?: string;
		log_path?: string;
		terminal_url?: string;
	}>;
	active_count: number;
	just_exited_count: number;
	tool_time_utc: string;
}): ListSessionsScriptResult {
	return {
		sessions: value.sessions.map((s) =>
			compact({
				session_id: s.session_id,
				command: safeMeta(s.command),
				cwd: optionalMeta(s.cwd),
				shell: optionalMeta(s.shell),
				pid: s.pid,
				elapsed_ms: s.elapsed_ms,
				running: s.running,
				wake_armed: s.wake_armed,
				monitor: s.monitor,
				exit_code: s.exit_code ?? undefined,
				signal: optionalMeta(s.signal),
				log_path: optionalMeta(s.log_path),
				terminal_url: s.terminal_url,
			}),
		),
		active_count: value.active_count,
		just_exited_count: value.just_exited_count,
		tool_time_utc: value.tool_time_utc,
	};
}
