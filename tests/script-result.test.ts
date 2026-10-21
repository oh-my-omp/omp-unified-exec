import type { FinalScreenOutput } from "../src/collect.ts";


/**
 * Structured tool results: every tool declares an `outputSchema` and returns
 * matching `structuredContent`, with `output` as a real multi-line string.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { activate } from "../src/index.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResultSchema,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResultSchema,
} from "../src/script-result.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { finalizeKillResult, finalizeProcessResult, renderProcessResultText } from "../src/tool-result.ts";


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


function assertPlainJson(value: unknown): void {
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "structuredContent must be plain JSON");
}

function processInput(overrides: Partial<Parameters<typeof finalizeProcessResult>[0]> = {}) {
	return {
		operation: "exec_command" as const,
		wallTimeSec: 0.25,
		collected: finalScreen("hello\nworld\n"),
		sessionId: undefined,
		exitCode: 0,
		signal: null,
		failure: null,
		logPath: "/tmp/session.log",
		...overrides,
	};
}

function makeHarness() {
	const tools: Record<string, any> = {};
	const ctx = {
		cwd: process.cwd(),
		ui: { notify() {}, setStatus() {}, setWidget() {}, select: async () => undefined },
		hasUI: false,
	};
	const pi = {
		registerTool: (def: any) => (tools[def.name] = def),
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		registerMessageRenderer() {},
		getFlag: () => false,
		getActiveTools: () => [],
		setActiveTools() {},
	};
	// The fake supplies only the ExtensionAPI surfaces consumed by the tool core.
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api);
	return {
		tools,
		call: (name: string, params: any) => tools[name].execute("test-call-id", params, undefined, undefined, ctx),
	};
}

describe("script result projections", () => {
	it("exited process: real newlines, exit code, schema-valid plain JSON", () => {
		const details = finalizeProcessResult(processInput());
		const value = processScriptResult(details);
		assert.ok(Value.Check(processScriptResultSchema, value));
		assertPlainJson(value);
		assert.equal(value.status, "exited");
		assert.equal(value.running, false);
		assert.equal(value.exit_code, 0);
		assert.equal(value.output, "hello\nworld\n");
		assert.equal(value.truncated, false);
		assert.equal(value.session_id, undefined);
	});

	it("running process exposes session_id; non-zero exit and signal are typed", () => {
		const running = processScriptResult(finalizeProcessResult(processInput({ sessionId: 3, exitCode: undefined })));
		assert.ok(Value.Check(processScriptResultSchema, running));
		assert.equal(running.status, "running");
		assert.equal(running.session_id, 3);
		assert.equal(running.exit_code, undefined);

		const failed = processScriptResult(
			finalizeProcessResult(processInput({ exitCode: 2, signal: "SIGTERM", failure: "boom\nsecond line" })),
		);
		assert.ok(Value.Check(processScriptResultSchema, failed));
		assert.equal(failed.exit_code, 2);
		assert.equal(failed.signal, "SIGTERM");
		assert.equal(failed.failure_message, "boom second line", "metadata stays single-line and bounded");
	});

	it("truncated output stays within Pi's byte cap and is flagged", () => {
		const big = "x".repeat(DEFAULT_MAX_BYTES * 2);
		const value = processScriptResult(
			finalizeProcessResult(processInput({ collected: finalScreen(big) })),
		);
		assert.ok(Value.Check(processScriptResultSchema, value));
		assert.equal(value.truncated, true);
		assert.ok(Buffer.byteLength(value.output) <= DEFAULT_MAX_BYTES);
	});

	it("terminal control sequences never reach script output", () => {
		const value = processScriptResult(
			finalizeProcessResult(
				processInput({
					collected: finalScreen("\u001b[31mred\u001b[0m\u0007 ok\n"),
				}),
			),
		);
		assert.doesNotMatch(value.output, /\u001b|\u0007/);
		assert.match(value.output, /red ok/);
	});


	it("kill results, including failed and unknown sessions, match the kill schema", () => {
		const killInput = {
			wallTimeSec: 0.1,
			collected: finalScreen("bye\n"),
			sessionId: 4,
			pid: 1234,
			requestedSignal: "SIGTERM" as NodeJS.Signals,
			exitCode: undefined,
			signal: "SIGTERM" as NodeJS.Signals,
			failure: null,
			escalated: false,
			killed: true,
		};
		const killed = killScriptResult(finalizeKillResult(killInput));
		assert.ok(Value.Check(killScriptResultSchema, killed));
		assert.equal(killed.status, "killed");
		assert.equal(killed.output, "bye\n");

		const failed = killScriptResult(finalizeKillResult({ ...killInput, killed: false, failure: "still alive" }));
		assert.ok(Value.Check(killScriptResultSchema, failed));
		assert.equal(failed.status, "kill_failed");
		assert.equal(failed.running, true);

		const missing = killNotFoundScriptResult(99);
		assert.ok(Value.Check(killScriptResultSchema, missing));
		assert.equal(missing.found, false);
	});
});

describe("registered tools return structuredContent", { skip: IS_WINDOWS }, () => {
	it("every tool declares an outputSchema", () => {
		const { tools } = makeHarness();
		for (const name of ["exec_command", "write_stdin", "kill_session", "list_sessions", "set_on_exit"]) {
			assert.ok(tools[name]?.outputSchema, `${name} must declare outputSchema`);
		}
	});

	it("exec_command keeps model content unchanged and mirrors details.output", async () => {
		const { call } = makeHarness();
		const result = await call("exec_command", { cmd: "printf 'a\\nb\\n'; exit 3", yield_time_ms: 5000 });
		assert.equal(result.content[0].text, renderProcessResultText(result.details));
		assert.ok(Value.Check(processScriptResultSchema, result.structuredContent));
		assertPlainJson(result.structuredContent);
		assert.equal(result.structuredContent.output, result.details.output);
		assert.equal(result.structuredContent.output, "a\nb");
		assert.equal(result.structuredContent.exit_code, 3);
	});

	it("write_stdin, list_sessions, set_on_exit and kill_session cover live and unknown sessions", { timeout: 15_000 }, async () => {
		const { call } = makeHarness();
		const started = await call("exec_command", { cmd: "echo ready; sleep 30", yield_time_ms: 300 });
		const sid = started.structuredContent.session_id;
		assert.equal(typeof sid, "number");
		assert.equal(started.structuredContent.status, "running");

		const written = await call("write_stdin", { session_id: sid, chars: "x", yield_time_ms: 250 });
		assert.ok(Value.Check(processScriptResultSchema, written.structuredContent));
		assert.equal(written.structuredContent.running, true);

		const listed = await call("list_sessions", {});
		assert.ok(Value.Check(listSessionsScriptResultSchema, listed.structuredContent));
		assertPlainJson(listed.structuredContent);
		assert.ok(listed.structuredContent.sessions.some((s: any) => s.session_id === sid && s.running));

		const armed = await call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, armed.structuredContent));
		assert.equal(armed.structuredContent.wake_armed, true);
		const unknownOnExit = await call("set_on_exit", { session_id: 999_999, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, unknownOnExit.structuredContent));
		assert.equal(unknownOnExit.structuredContent.found, false);

		const killed = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, killed.structuredContent));
		assert.equal(killed.structuredContent.status, "killed");
		const unknownKill = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, unknownKill.structuredContent));
		assert.equal(unknownKill.structuredContent.found, false);
	});
});

