import type { FinalScreenOutput } from "../src/collect.ts";


import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MAX_LINES, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	execShellArgs,
	killShellArgs,
	parseResultView,
	toShellResult,
	type ActivatedExtension,
	withHostPresentation,
	writeStdinShellArgs,
} from "../fork-features/omp-presentation.ts";
import { renderExecCommandCall, renderProcessResult } from "../src/render.ts";
import { SessionStore } from "../src/session-store.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	truncationMarker,
	type FinalizeKillInput,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "../src/tool-result.ts";


function finalScreen(text: string): FinalScreenOutput {
	const lines = text.split("\n");
	return {
		kind: "final-screen",
		terminalUrl: "term://test",
		projection: {
			view: { screen: "normal", cols: 120, rows: lines.length, cursor: { row: 1, col: 1 } },
			retainedLines: lines, screenLines: lines, cells: [], appearance: "dark", historyMayBeTruncated: false,
		},
	};
}


// Persisted shapes from the real tool-result survey, with stable fixture paths.
const exitedDetails: ProcessResultDetails = {
	chunk_id: "86445f",
	wall_time_seconds: 0.007,
	output: "ok\n",
	original_token_count: 1,
	log_path: "/tmp/omp-presentation-exit.log",
	output_bytes_total: 3,
	operation: "exec_command",
	status: "exited",
	running: false,
	exit_code: 0,
	cwd: "/repo",
	command: "echo ok",
	yield_time_ms: 10000,
};

const processInput: FinalizeProcessInput = {
	operation: "exec_command",
	wallTimeSec: 0.25,
	collected: finalScreen("last output\n"),
	sessionId: undefined,
	exitCode: 0,
	signal: null,
	failure: null,
	logPath: "/tmp/omp-presentation-process.log",
};

const killInput: FinalizeKillInput = {
	wallTimeSec: 0.003,
	collected: finalScreen("last output\n"),
	totalBytes: 12,
	sessionId: 1,
	pid: 45828,
	requestedSignal: "SIGTERM",
	exitCode: undefined,
	signal: "SIGTERM",
	failure: null,
	logPath: "/tmp/omp-presentation-kill.log",
	cwd: "/repo",
	command: "cat",
	escalated: false,
	killed: true,
};

function processView(details: ProcessResultDetails) {
	return parseResultView({
		details,
		content: [{ type: "text", text: renderProcessResultText(details) }],
		isError: false,
	}, false);
}

const noisyOutput = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, index) => `line-${index + 1}`).join("\n");

describe("omp shell result presentation", () => {
	it("presents a zero exit as output only, with milliseconds and a successful exit code", () => {
		const view = processView(exitedDetails);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: exitedDetails.output }],
			details: { exitCode: 0, wallTimeMs: exitedDetails.wall_time_seconds * 1000 },
			isError: false,
		});
	});

	it("classifies a nonzero exit as an error even when the tool envelope is not an error", () => {
		const details = { ...exitedDetails, output: "boom\n", exit_code: 3, command: "echo boom; exit 3" };
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "boom\n" }],
			details: { exitCode: 3, wallTimeMs: 7 },
			isError: true,
		});
	});

	for (const operation of ["exec_command", "write_stdin"] as const) {
		it(`presents a yielded live ${operation} result as backgrounded`, () => {
			const details: ProcessResultDetails = {
				chunk_id: "6cba2f",
				wall_time_seconds: 0.501,
				output: "",
				original_token_count: 0,
				log_path: "/tmp/omp-presentation-live.log",
				output_bytes_total: 0,
				operation,
				status: "running",
				running: true,
				session_id: 1,
				cwd: "/repo",
				command: "sleep 3; echo done",
				tool_time_utc: "2026-10-10T11:34:59.455Z",
			};
			const view = processView(details);
			assert.equal(view.kind, "backgrounded");
			assert.deepEqual(toShellResult(view), {
				content: [{ type: "text", text: "" }],
				details: { wallTimeMs: 501, async: { state: "running", jobId: "session 1", type: "bash" } },
				isError: false,
			});
		});
	}

	it("presents partial details as streaming without terminal or background metadata", () => {
		const details = {
			session_id: 1,
			pid: 45842,
			running: true,
			total_bytes: 18,

			command: "printf 'update-1\\n'; sleep 0.35; printf 'update-2\\n'",
			cwd: "/repo",
			log_path: "/tmp/omp-presentation-stream.log",
			output: "update-1\nupdate-2\n",
		};
		const view = parseResultView({ details, content: [{ type: "text", text: details.output }] }, true);
		assert.deepEqual(view, { kind: "streaming", output: details.output });
		const result = toShellResult(view);
		assert.deepEqual(result, { content: [{ type: "text", text: details.output }], details: {}, isError: false });
		for (const field of ["exitCode", "wallTimeMs", "async"]) {
			assert.equal(Object.hasOwn(result.details, field), false);
		}
	});

	it("appends the exact recovery marker after a blank line and keeps it last", () => {
		const details = finalizeProcessResult({
			...processInput,
			collected: finalScreen(noisyOutput),
		});
		const marker = truncationMarker(details.truncation, details.log_path);
		assert.equal(details.truncation?.truncated, true);
		assert.equal(marker, `[Showing lines 1001-3000 of 3000. Full output: ${details.log_path}]`);
		const result = toShellResult(processView(details));
		assert.equal(result.content[0].text, `${details.output.replace(/\n+$/, "")}\n\n${marker}`);
		assert.equal(result.content[0].text.split("\n").at(-1), marker);
		assert.equal(result.isError, false);
	});

	it("shows a nonexistent-workdir failure and marks it as an error", () => {
		const failure = "process error: ENOENT: no such file or directory, posix_spawn 'bash' (check shell binary and workdir: /definitely/not/a/real/dir)";
		const details: ProcessResultDetails = {
			...exitedDetails,
			output: "",
			exit_code: undefined,
			wall_time_seconds: 0.001,
			failure_message: failure,
			cwd: "/definitely/not/a/real/dir",
			command: "echo hi",
		};
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: `[failure: ${failure}]` }],
			details: { exitCode: undefined, wallTimeMs: 1 },
			isError: true,
		});
	});

	it("marks signal-terminated exec as an error and shows its signal", () => {
		const details = finalizeProcessResult({ ...processInput, exitCode: undefined, signal: "SIGTERM" });
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "last output\n\n[signal: SIGTERM]" }],
			details: { exitCode: undefined, wallTimeMs: 250 },
			isError: true,
		});
	});

	it("does not treat the expected SIGTERM from successful kill as an error", () => {
		const details = finalizeKillResult(killInput);
		assert.equal(details.signal, "SIGTERM");
		const view = parseResultView({ details, content: [{ type: "text", text: renderKillResultText(details) }] }, false);
		assert.equal(view.kind, "killed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: details.output }],
			details: { wallTimeMs: 3 },
			isError: false,
		});
	});

	it("shows SIGKILL escalation without making a successful kill an error", () => {
		const details = finalizeKillResult({ ...killInput, escalated: true, signal: "SIGKILL" });
		const view = parseResultView({ details }, false);
		assert.equal(view.kind, "killed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "last output\n\n[escalated to SIGKILL]" }],
			details: { wallTimeMs: 3 },
			isError: false,
		});
	});

	it("shows failed kill diagnostics and marks the result as an error", () => {
		const failure = "process still running; session remains registered";
		const details = finalizeKillResult({ ...killInput, killed: false, signal: null, failure, escalated: true });
		const view = parseResultView({ details }, false);
		assert.equal(view.kind, "kill_failed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: `last output\n\n[kill failed: ${failure}]` }],
			details: { wallTimeMs: 3 },
			isError: true,
		});
	});

	for (const isError of [false, undefined]) {
		it(`marks no-such-session kill as an error with outer isError=${isError}`, () => {
			const view = parseResultView({
				details: { operation: "kill_session", status: "kill_failed", running: false, session_id: 9, found: false },
				content: [{ type: "text", text: "No such session: 9" }],
				isError,
			}, false);
			assert.deepEqual(view, { kind: "message", text: "No such session: 9", isError: true });
			assert.deepEqual(toShellResult(view), {
				content: [{ type: "text", text: "No such session: 9" }],
				details: {},
				isError: true,
			});
		});
	}

	it("preserves thrown-error text and error status without details", () => {
		const view = parseResultView({
			details: undefined,
			content: [{ type: "text", text: "unknown session_id: 999999" }],
			isError: true,
		}, false);
		assert.deepEqual(view, { kind: "message", text: "unknown session_id: 999999", isError: true });
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "unknown session_id: 999999" }],
			details: {},
			isError: true,
		});
	});

	it("strips ANSI and OSC controls from persisted output and failure notices", () => {
		const details = {
			...exitedDetails,
			output: "\x1b[31mred\x1b[0m\x1b]52;c;YXR0YWNrZXI=\x07\n",
			failure_message: "\x1b[31mbad\x1b[0m\x1b]0;unsafe title\x1b\\ workdir",
		};
		const result = toShellResult(processView(details));
		assert.equal(result.content[0].text, "red\n\n[failure: bad workdir]");
		assert.doesNotMatch(result.content[0].text, /[\u001b\u0007\u009b\u009d]/);
		assert.equal(result.isError, true);
	});

	for (const scenario of ["signal", "failure", "escalated kill", "failed kill"] as const) {
		it(`keeps recovery marker last when truncated output also has a ${scenario} notice`, () => {
			const collected = finalScreen(noisyOutput);
			const details = scenario === "signal" || scenario === "failure"
				? finalizeProcessResult({
					...processInput,
					collected,
					exitCode: undefined,
					signal: scenario === "signal" ? "SIGTERM" : null,
					failure: scenario === "failure" ? "process error" : null,
				})
				: finalizeKillResult({
					...killInput,
					collected,
					escalated: true,
					killed: scenario === "escalated kill",
					signal: scenario === "escalated kill" ? "SIGKILL" : null,
					failure: scenario === "failed kill" ? "process still running" : null,
				});
			const marker = truncationMarker(details.truncation, details.log_path);
			assert.equal(details.truncation?.truncated, true);
			assert.ok(marker);
			const text = toShellResult(parseResultView({ details }, false)).content[0].text;
			assert.equal(text.split("\n").at(-1), marker);
			assert.ok(text.startsWith(`${details.output.replace(/\n+$/, "")}\n\n`), "notices must follow a blank line");
		});
	}
});

describe("omp shell argument presentation", () => {
	it("projects exec command and workdir without inventing a cwd for empty or absent args", () => {
		assert.deepEqual(execShellArgs({ cmd: "echo ok", workdir: "/repo" }), { command: "echo ok", cwd: "/repo" });
		assert.deepEqual(execShellArgs({ cmd: "echo ok", workdir: "" }), { command: "echo ok", cwd: undefined });
		assert.deepEqual(execShellArgs({}), { command: undefined, cwd: undefined });
		assert.deepEqual(execShellArgs(undefined), { command: undefined, cwd: undefined });
	});

	it("describes polls, escaped stdin, and base64 byte counts as shell comments", () => {
		assert.deepEqual(writeStdinShellArgs({ session_id: 1 }), { command: "# poll session 1" });
		assert.deepEqual(writeStdinShellArgs({ session_id: 1, chars: "" }), { command: "# poll session 1" });
		assert.deepEqual(writeStdinShellArgs({ session_id: 1, chars: "q\n" }), { command: '# stdin → session 1: "q\\n"' });
		assert.deepEqual(writeStdinShellArgs({ session_id: 1, chars_b64: "aGk=" }), { command: "# stdin → session 1: 2 bytes" });
		assert.deepEqual(writeStdinShellArgs({}), { command: "# poll session ?" });
		assert.deepEqual(writeStdinShellArgs(undefined), { command: "# poll session ?" });
	});

	it("describes default and custom kill signals, including streamed missing args", () => {
		assert.deepEqual(killShellArgs({ session_id: 1 }), { command: "# kill session 1 (SIGTERM)" });
		assert.deepEqual(killShellArgs({ session_id: 1, signal: "SIGINT" }), { command: "# kill session 1 (SIGINT)" });
		assert.deepEqual(killShellArgs(undefined), { command: "# kill session ? (SIGTERM)" });
	});
});

describe("host presentation activation", () => {
	const parameters = Type.Object({ cmd: Type.Optional(Type.String()) });
	const definition: ToolDefinition<typeof parameters, ProcessResultDetails> = {
		name: "exec_command",
		label: "Exec",
		description: "Test registration",
		parameters,
		execute: async () => { throw new Error("This registration test must not execute a tool"); },
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	};

	it("activates Pi synchronously and preserves the definition and renderer identities", () => {
		const registered: Array<typeof definition> = [];
		const api = { registerTool: (tool: typeof definition) => registered.push(tool) } as unknown as ExtensionAPI;
		let activations = 0;
		let returned = false;
		const activate = withHostPresentation((host): ActivatedExtension => {
			assert.equal(returned, false);
			assert.equal(host, api);
			activations++;
			host.registerTool(definition);
			return { store: new SessionStore({ maxSessions: 10, lruProtectedCount: 2 }), kill: async () => false };
		});
		const result = activate(api);
		returned = true;
		assert.equal(result, undefined);
		assert.equal(activations, 1);
		assert.deepEqual(registered, [definition]);
		assert.equal(registered[0], definition);
		assert.equal(registered[0].renderCall, renderExecCommandCall);
		assert.equal(registered[0].renderResult, renderProcessResult);
	});

	it("rejects omp activation when its required renderer module is absent, without Pi fallback", async () => {
		const registered: Array<typeof definition> = [];
		const api = {
			arktype: {},
			registerTool: (tool: typeof definition) => registered.push(tool),
		} as unknown as ExtensionAPI;
		let activations = 0;
		const activate = withHostPresentation((host): ActivatedExtension => {
			activations++;
			host.registerTool(definition);
			return { store: new SessionStore({ maxSessions: 10, lruProtectedCount: 2 }), kill: async () => false };
		});
		const result = activate(api);
		assert.ok(result instanceof Promise);
		await assert.rejects(result, {
			code: "ERR_MODULE_NOT_FOUND",
			message: /@oh-my-pi\/pi-tui/,
		});
		assert.equal(activations, 0);
		assert.deepEqual(registered, []);
	});
});
