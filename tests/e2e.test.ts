/**
 * End-to-end tests for unified-exec.
 *
 * Exercises the full tool pipeline by instantiating the extension with a stub
 * ExtensionAPI and calling the registered tools' `execute` functions directly.
 * Bypasses pi's event loop but uses the real SessionStore / ExecSession /
 * SpawnedChild code paths.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { activate, MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";


interface ToolDef {
	name: string;
	description: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any; structuredContent?: unknown }>;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
}

function makeHarness(shellPath?: () => string | undefined) {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		statuses: new Map<string, string | undefined>(),
		widgets: new Map<string, { content: string[] | undefined; options?: unknown }>(),
		// Queue of responders for ui.select(); each gets the options array.
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => uiEvents.statuses.set(key, value),
			setWidget: (key: string, content: string[] | undefined, options?: unknown) =>
				uiEvents.widgets.set(key, { content, options }),
			select: (_title: string, options: string[]) => {
				const responder = uiEvents.selectResponses.shift();
				return Promise.resolve(responder ? responder(options) : undefined);
			},
		},
		hasUI: false,
	};

	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};

	// Activate the tool core directly; factory admission is covered separately.
	// The fake supplies only the ExtensionAPI surfaces consumed by the tool core.
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api, undefined, shellPath);

	return {
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, onUpdate, stubCtx);
		},
		async invokeCommand(name: string, args = "") {
			const cmd = commands[name];
			if (!cmd) throw new Error(`no such command: ${name}`);
			return cmd.handler(args, stubCtx);
		},
		stubCtx,
		tools,
		uiEvents,
		async emit(event: string, evt: any = {}) {
			const results = [];
			for (const h of handlers[event] ?? []) results.push(await h(evt, stubCtx));
			return results;
		},
	};
}

function assertReportedShell(
	result: { content: Array<{ text: string }>; details: { shell?: string }; structuredContent?: unknown },
	shell: string,
) {
	assert.equal(result.details.shell, shell);
	assert.ok(result.structuredContent && typeof result.structuredContent === "object" && "shell" in result.structuredContent);
	assert.equal(result.structuredContent.shell, shell);
	assert.ok(result.content[0].text.split("\n").includes(`shell: ${shell}`), result.content[0].text);
}

/** Poll until `cond` is true or the deadline passes (CI runners are slow). */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return cond();
}

describe("unified-exec e2e", () => {
	it("resolveMaxEmptyPollMs has no default cap and permits operator limits above 290s", () => {
		assert.equal(resolveMaxEmptyPollMs({}), undefined);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "300000" }), 300_000);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "60000" }), 60_000);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "1000" }), 5_000);
		assert.throws(() => resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "not-a-number" }), /positive finite/);
	});

	it("describes uncapped empty waits without cache-TTL polling guidance", () => {
		const h = makeHarness();
		for (const name of ["exec_command", "write_stdin"]) {
			const tool = h.tools[name];
			const prompt = JSON.stringify([tool.description, tool.promptGuidelines, tool.parameters]);
			assert.doesNotMatch(prompt, /290|cache-friendly/);
			assert.match(prompt, /no built-in (?:empty-poll )?maximum/i);
		}
		assert.match(h.tools.write_stdin.promptGuidelines!.join("\n"), /yield_until ONLY when the human explicitly asks/);
	});

	it("leaves presentation hooks to the omp factory rather than the tool core", () => {
		const h = makeHarness();
		for (const name of ["exec_command", "write_stdin", "set_on_exit", "monitor", "kill_session", "list_sessions"]) {
			assert.equal(h.tools[name]?.renderCall, undefined, `${name} has a core renderCall`);
			assert.equal(h.tools[name]?.renderResult, undefined, `${name} has a core renderResult`);
		}
	});

	it("Windows: shell=powershell and shell=cmd get shell-appropriate flags", { skip: !IS_WINDOWS }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "Write-Output ps-ok", shell: "powershell", yield_time_ms: 20000 });
		assert.equal(r1.details.exit_code, 0, `powershell details=${JSON.stringify(r1.details)}`);
		assert.ok(
			r1.details.output.includes("ps-ok"),
			`powershell output=${JSON.stringify(r1.details.output)} session_id=${r1.details.session_id}`,
		);
		const r2 = await h.call("exec_command", { cmd: "echo cmd-ok", shell: "cmd", yield_time_ms: 20000 });
		assert.equal(r2.details.exit_code, 0, `cmd details=${JSON.stringify(r2.details)}`);
		assert.ok(r2.details.output.includes("cmd-ok"), `cmd output=${JSON.stringify(r2.details.output)}`);
		await h.emit("session_shutdown");
	});

	it("POSIX: an explicit shell overrides SHELL and reports the resolved interpreter", { skip: IS_WINDOWS }, async () => {
		const previous = process.env.SHELL;
		const h = makeHarness();
		try {
			await h.emit("session_start");
			for (const defaultShell of ["/bin/sh", "definitely-not-a-real-default-shell-xyz"]) {
				process.env.SHELL = defaultShell;
				const result = await h.call("exec_command", {
					cmd: 'printf "bash-version:%s\\n" "${BASH_VERSION:?not running bash}"',
					shell: "bash",
					yield_time_ms: 2000,
				});
				assert.equal(result.details.exit_code, 0, JSON.stringify(result.details));
				assert.match(result.details.output, /bash-version:\d/);
				const shell: unknown = result.details.shell;
				assert.equal(typeof shell, "string");
				assert.ok(typeof shell === "string" && isAbsolute(shell), `unresolved shell: ${shell}`);
				assertReportedShell(result, shell);
			}
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
			await h.emit("session_shutdown");
		}
	});

	it("POSIX: live host shellPath outranks SHELL, explicit shell wins, and invalid host shells never fall back", { skip: IS_WINDOWS }, async () => {
		const previous = process.env.SHELL;
		let hostShell: string | undefined = "/bin/sh";
		let reads = 0;
		const h = makeHarness(() => {
			reads++;
			return hostShell;
		});
		try {
			await h.emit("session_start");
			process.env.SHELL = "bash";
			assert.equal(reads, 0, "activation must not snapshot shellPath");
			const first = await h.call("exec_command", { cmd: 'printf "interpreter:%s\\n" "$0"' });
			assert.equal(first.details.exit_code, 0, JSON.stringify(first.details));
			assert.match(first.details.output, /interpreter:\/bin\/sh/);
			assertReportedShell(first, "/bin/sh");
			assert.equal(reads, 1);

			hostShell = "bash";
			process.env.SHELL = "/bin/sh";
			const second = await h.call("exec_command", {
				cmd: 'printf "bash-version:%s\\n" "${BASH_VERSION:?not running bash}"',
			});
			assert.equal(second.details.exit_code, 0, JSON.stringify(second.details));
			assert.match(second.details.output, /bash-version:\d/);
			assert.ok(isAbsolute(second.details.shell));
			assertReportedShell(second, second.details.shell);
			assert.equal(reads, 2);

			hostShell = "definitely-not-a-real-host-shell-xyz";
			const explicit = await h.call("exec_command", { cmd: "echo explicit-wins", shell: "/bin/sh" });
			assert.equal(explicit.details.exit_code, 0, JSON.stringify(explicit.details));
			assert.match(explicit.details.output, /explicit-wins/);
			assertReportedShell(explicit, "/bin/sh");
			assert.equal(reads, 2, "explicit shell must bypass host settings");

			const failed = await h.call("exec_command", { cmd: "echo fallback-must-not-run" });
			assert.match(failed.details.failure_message, /ENOENT/);
			assert.doesNotMatch(failed.details.output, /fallback-must-not-run/);
			assertReportedShell(failed, hostShell);
			assert.equal(reads, 3);

			for (hostShell of [undefined, "", " \t\n"]) {
				const fallback = await h.call("exec_command", { cmd: "echo environment-shell" });
				assert.equal(fallback.details.exit_code, 0, JSON.stringify(fallback.details));
				assert.match(fallback.details.output, /environment-shell/);
				assertReportedShell(fallback, "/bin/sh");
			}
			assert.equal(reads, 6);
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
			await h.emit("session_shutdown");
		}
	});

	it("POSIX: live SHELL selects new PTYs while poll, list, kill, and streams retain the original shell", { skip: IS_WINDOWS }, async () => {
		const previous = process.env.SHELL;
		const h = makeHarness();
		try {
			await h.emit("session_start");
			process.env.SHELL = " \t/bin/sh \n";
			const initialUpdates: Array<{ details: { shell?: string } }> = [];
			const started = await h.call(
				"exec_command",
				{
					cmd: 'stty -echo; printf "interpreter:%s\\n" "$0"; while IFS= read -r line; do printf "reply:%s\\n" "$line"; done',
					yield_time_ms: 1000,
				},
				undefined,
				(partial: { details: { shell?: string } }) => initialUpdates.push(partial),
			);
			const sid: unknown = started.details.session_id;
			assert.equal(typeof sid, "number", JSON.stringify(started.details));
			assert.ok(typeof sid === "number");
			assert.match(started.details.output, /interpreter:\/bin\/sh/);
			assertReportedShell(started, "/bin/sh");
			assert.ok(initialUpdates.length > 0, "expected a streaming update from the live readline loop");
			assert.ok(initialUpdates.every((update) => update.details.shell === "/bin/sh"));

			// A new default invocation must use the changed environment, not the
			// earlier /bin/sh selection or a cached platform fallback.
			process.env.SHELL = "bash";
			const next = await h.call("exec_command", {
				cmd: 'printf "new-bash-version:%s\\n" "${BASH_VERSION:?not running bash}"',
				yield_time_ms: 2000,
			});
			assert.equal(next.details.exit_code, 0, JSON.stringify(next.details));
			assert.match(next.details.output, /new-bash-version:\d/);
			const nextShell: unknown = next.details.shell;
			assert.ok(typeof nextShell === "string" && isAbsolute(nextShell));
			assert.notEqual(nextShell, "/bin/sh");
			assertReportedShell(next, nextShell);

			// Neither querying nor terminating the old PTY may resolve SHELL again.
			process.env.SHELL = "definitely-not-a-real-later-shell-xyz";
			const pollUpdates: Array<{ details: { shell?: string } }> = [];
			const polled = await h.call(
				"write_stdin",
				{ session_id: sid, chars: "still-original\n", yield_time_ms: 1000 },
				undefined,
				(partial: { details: { shell?: string } }) => pollUpdates.push(partial),
			);
			assert.equal(polled.details.session_id, sid);
			assert.match(polled.details.output, /reply:still-original/);
			assertReportedShell(polled, "/bin/sh");
			assert.ok(pollUpdates.length > 0, "expected a streaming update while the old PTY remains live");
			assert.ok(pollUpdates.every((update) => update.details.shell === "/bin/sh"));

			const listed = await h.call("list_sessions", {});
			const entries: Array<{ session_id: number; shell?: string }> = listed.details.sessions;
			assert.equal(entries.find((entry) => entry.session_id === sid)?.shell, "/bin/sh");
			assert.ok(
				listed.structuredContent && typeof listed.structuredContent === "object" && "sessions" in listed.structuredContent,
			);
			assert.ok(Array.isArray(listed.structuredContent.sessions));
			const structuredEntry: unknown = listed.structuredContent.sessions.find(
				(entry: unknown) => typeof entry === "object" && entry !== null && "session_id" in entry && entry.session_id === sid,
			);
			assert.ok(structuredEntry && typeof structuredEntry === "object" && "shell" in structuredEntry);
			assert.equal(structuredEntry.shell, "/bin/sh");
			assert.ok(listed.content[0].text.includes("shell: /bin/sh"));

			const killed = await h.call("kill_session", { session_id: sid });
			assert.equal(killed.details.killed, true, JSON.stringify(killed.details));
			assertReportedShell(killed, "/bin/sh");
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
			await h.emit("session_shutdown");
		}
	});

	it("Windows: cmd.exe quoting survives operators, quotes, %VAR%, parens", { skip: !IS_WINDOWS }, async () => {
		// These are exactly the inputs the /d /s /c "<cmd>" + verbatim-args
		// mechanism exists for; `echo simple` would pass even if it broke.
		const h = makeHarness();
		await h.emit("session_start");
		const cases: Array<{ cmd: string; expect: string[] }> = [
			{ cmd: "echo one& echo two", expect: ["one", "two"] }, // & separator
			{ cmd: 'echo "a & b"', expect: ['"a & b"'] }, // quoted & is literal
			{ cmd: "echo %OS%", expect: ["Windows_NT"] }, // env expansion
			{ cmd: "(echo grouped)", expect: ["grouped"] }, // parentheses
			// findstr, not find: Git Bash environments often shadow Windows'
			// find.exe with GNU find earlier on PATH.
			{ cmd: "echo piped-x | findstr piped", expect: ["piped-x"] }, // pipe
		];
		for (const { cmd, expect } of cases) {
			const r = await h.call("exec_command", { cmd, shell: "cmd", yield_time_ms: 20000 });
			assert.equal(r.details.exit_code, 0, `cmd=${cmd} details=${JSON.stringify(r.details)}`);
			for (const e of expect) {
				assert.ok(r.details.output.includes(e), `cmd=${cmd} expected "${e}" in output=${r.details.output}`);
			}
		}
		await h.emit("session_shutdown");
	});

	it("short-lived command returns exit_code and no session_id", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello && echo world" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		assert.ok(r.details.output.includes("hello"));
		assert.ok(r.details.output.includes("world"));
		await h.emit("session_shutdown");
	});

	it("process that exits BETWEEN calls is still drainable via write_stdin", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 3 ticks @ 200ms = 600ms runtime. Yield at 250ms -> session_id returned.
		// Then wait 800ms so the process exits, then poll.
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3; do echo tock $i; sleep 0.2; done",
			yield_time_ms: 250,
		});
		assert.ok(
			typeof r1.details.session_id === "number",
			`first yield should return session_id; got ${JSON.stringify(r1.details)}`,
		);
		const sid = r1.details.session_id;

		// Wait for the process to definitely exit (600ms runtime - 250ms yield + slack).
		await new Promise((r) => setTimeout(r, 800));

		// Now poll — process has already exited, but the store should still have
		// the entry so we can observe the exit and drain trailing output.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `expected exit_code=0; got ${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		assert.ok(r2.details.output.includes("tock 3"), `expected 'tock 3' in output: ${r2.details.output}`);
		await h.emit("session_shutdown");
	});

	it("empty write_stdin accepts a long relative wait and returns early on exit", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		delete process.env[MAX_EMPTY_POLL_ENV_VAR];
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.6; echo long-poll-finished",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;
			const start = performance.now();
			const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 2_000_000 });
			assert.ok(performance.now() - start < 10_000);
			assert.equal(r2.details.yield_time_ms, 2_000_000);
			assert.equal(r2.details.session_id, undefined);
			assert.equal(r2.details.exit_code, 0);
			assert.equal(r2.details.wait_mode, "relative");
			assert.equal(r2.details.wait_status, "completed");
			assert.equal(r2.details.yield_until, undefined);
			assert.match(r2.details.output, /long-poll-finished/);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
	});

	it("an explicit operator cap rejects longer relative waits without clamping", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		process.env[MAX_EMPTY_POLL_ENV_VAR] = "10000";
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.4",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;

			await new Promise((r) => setTimeout(r, 700));

			// Values above the lowered cap are rejected against that cap…
			await assert.rejects(
				() => h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 20_000 }),
				/exceeds the configured empty-poll cap of 10000 ms/,
			);
			// …while in-cap values behave normally.
			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "",
				yield_time_ms: 10_000,
			});
			assert.equal(r2.details.yield_time_ms, 10_000);
			assert.equal(r2.details.session_id, undefined);
			assert.equal(r2.details.exit_code, 0);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
	});

	it("long-running command yields session_id and write_stdin resumes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 5 ticks, 0.3s apart = ~1.5s total. Yield at 600ms.
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3 4 5; do echo tick $i; sleep 0.3; done",
			yield_time_ms: 600,
		});
		assert.equal(r1.details.exit_code, undefined, "should still be running");
		assert.ok(typeof r1.details.session_id === "number", `got session_id=${r1.details.session_id}`);
		const sid = r1.details.session_id;
		// Expect ~ticks 1-2 in first yield.
		assert.ok(r1.details.output.includes("tick 1"), `first out: ${r1.details.output}`);

		// Poll with big yield to catch the rest + exit.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `r2=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		assert.ok(r2.details.output.includes("tick 5"), `second out: ${r2.details.output}`);
		await h.emit("session_shutdown");
	});

	it("write_stdin sends input and terminal EOF to cat", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Disable terminal echo so the observed line must come from cat.
		const r1 = await h.call("exec_command", {
			cmd: "stty -echo; exec cat",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
		const sid = r1.details.session_id;

		// Send a line.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "hello from stdin\n",
			yield_time_ms: 400,
		});
		assert.ok(r2.details.output.includes("hello from stdin"), `got ${JSON.stringify(r2.details)}`);
		assert.ok(typeof r2.details.session_id === "number");

		// Send EOF so cat exits. The call returns as soon as the exit is observed.
		const r3 = await h.call("write_stdin", {
			session_id: sid,
			chars: "\x04",
			yield_time_ms: 5000,
		});
		assert.equal(r3.details.exit_code, 0);
		assert.equal(r3.details.session_id, undefined);
		await h.emit("session_shutdown");
	});

	it("kill_session terminates a stuck process", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 60",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number");
		const sid = r1.details.session_id;

		const t0 = Date.now();
		const r2 = await h.call("kill_session", { session_id: sid });
		const dt = Date.now() - t0;
		assert.ok(dt < 2500, `kill_session took too long: ${dt}ms`);
		assert.equal(r2.details.session_id, sid);
		// Either signal=SIGTERM, or exit_code set (sleep can be killed with no code).
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("kill_session bounds delayed noisy output while the log retains the complete stream", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			// Yield before the burst so kill_session, rather than exec_command,
			// owns the buffered output that exercises this regression.
			const started = await h.call("exec_command", {
				cmd: 'sleep 0.8; for i in $(seq 1 4000); do echo "kill-line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; sleep 60',
				yield_time_ms: 250,
			});
			const sid = started.details.session_id;
			assert.ok(typeof sid === "number", JSON.stringify(started.details));
			const logPath = started.details.log_path;
			assert.ok(typeof logPath === "string");
			assert.ok(
				await waitFor(() => {
					try {
						return readFileSync(logPath, "utf8").includes("kill-line-4000-");
					} catch {
						return false;
					}
				}),
				"noisy command did not finish its output burst",
			);

			const killed = await h.call("kill_session", { session_id: sid });
			assert.equal(killed.details.operation, "kill_session");
			assert.equal(killed.details.status, "killed");
			assert.equal(killed.details.running, false);
			assert.equal(killed.details.killed, true);
			assert.equal(Object.hasOwn(killed.details, "final_output"), false);
			assert.ok(Buffer.byteLength(killed.details.output, "utf8") <= DEFAULT_MAX_BYTES);
			assert.ok(killed.details.output.split("\n").length <= killed.details.terminal.rows);
			assert.match(killed.details.output, /kill-line-4000-/);
			assert.match(killed.content[0].text, /^\[killed\]/);
			assert.ok(
				Buffer.byteLength(killed.content[0].text, "utf8") < DEFAULT_MAX_BYTES + 4096,
				`kill content unexpectedly large: ${Buffer.byteLength(killed.content[0].text, "utf8")}`,
			);

			const fullLog = readFileSync(logPath, "utf8");
			// Count by content, not line start: ConPTY (Windows) writes its own
			// init and window-title sequences in front of the first lines.
			const logged = new Set([...fullLog.matchAll(/kill-line-(\d+)-/g)].map((m) => Number(m[1])));
			assert.equal(logged.size, 4000);
			assert.ok(logged.has(1) && logged.has(4000));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("kill_session escalates to SIGKILL when SIGTERM is trapped", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Trap SIGTERM so bash ignores it; SIGKILL should still work.
		const r1 = await h.call("exec_command", {
			cmd: "trap '' TERM; sleep 60",
			shell: "bash",
			yield_time_ms: 300,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid });
		if (IS_WINDOWS) {
			// No POSIX signals on Windows: the initial "SIGTERM" is already a
			// force tree-kill (taskkill /T /F) and escalation is skipped (a
			// second identical taskkill can't behave differently). Don't assert
			// on exit timing (taskkill on a loaded runner can exceed the 2s
			// window) — assert the session is gone from the store instead.
			assert.equal(r2.details.escalated, false, `details=${JSON.stringify(r2.details)}`);
			const l = await h.call("list_sessions", {});
			assert.ok(
				!l.details.sessions.some((s: any) => s.session_id === sid && s.running),
				`session ${sid} still listed as running: ${JSON.stringify(l.details)}`,
			);
		} else {
			assert.equal(r2.details.escalated, true, `details=${JSON.stringify(r2.details)}`);
		}
		await h.emit("session_shutdown");
	});

	it("list_sessions enumerates live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 300 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 2, `details=${JSON.stringify(l.details)}`);
		const ids = l.details.sessions.map((s: any) => s.session_id);
		assert.ok(ids.includes(r1.details.session_id));
		assert.ok(ids.includes(r2.details.session_id));
		// Cleanup.
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.call("kill_session", { session_id: r2.details.session_id });
		await h.emit("session_shutdown");
	});

	it("session_tree surfaces running sessions in the TUI", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");
		const widget = h.uiEvents.widgets.get("unified-exec.sessions");
		const widgetContent = widget?.content;
		if (!widgetContent) assert.fail(`widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent[0].includes("1 session still running"), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes(`#${sid}`)), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes("set_on_exit") || line.includes("write_stdin")), `widget=${JSON.stringify(widget)}`);
		assert.ok(
			h.uiEvents.notifications.some((n) => n.type === "warning" && n.message.includes("still running after /tree")),
			`notifications=${JSON.stringify(h.uiEvents.notifications)}`,
		);

		await h.call("kill_session", { session_id: sid });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), undefined);
		assert.equal(h.uiEvents.widgets.get("unified-exec.sessions")?.content, undefined);
		await h.emit("session_shutdown");
	});

	it("running-session footer clears automatically when a background process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");

		// Poll, don't fixed-sleep: `sleep 0.4` can take >700ms wall time on a
		// loaded CI runner (observed on windows-latest).
		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === undefined),
			`status did not clear: ${h.uiEvents.statuses.get("unified-exec.sessions")}`,
		);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		await h.emit("session_shutdown");
	});

	it("post-tree running-session widget clears automatically when the process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.ok(h.uiEvents.widgets.get("unified-exec.sessions")?.content?.[0].includes("1 session still running"));

		// Poll, don't fixed-sleep (slow CI runners).
		assert.ok(
			await waitFor(() => h.uiEvents.widgets.get("unified-exec.sessions")?.content === undefined),
			`widget did not clear: ${JSON.stringify(h.uiEvents.widgets.get("unified-exec.sessions"))}`,
		);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("running-session UI decrements when one of multiple sessions exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const short = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250 });
		const long = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 250 });
		const shortSid = short.details.session_id;
		const longSid = long.details.session_id;
		assert.ok(typeof shortSid === "number", `short=${JSON.stringify(short.details)}`);
		assert.ok(typeof longSid === "number", `long=${JSON.stringify(long.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 2 sessions running");

		// Poll for the short session's exit instead of a fixed 1.1s sleep.
		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === "unified-exec: 1 session running"),
			`status did not decrement: ${h.uiEvents.statuses.get("unified-exec.sessions")}`,
		);
		const widget = h.uiEvents.widgets.get("unified-exec.sessions")?.content?.join("\n") ?? "";
		assert.ok(widget.includes(`#${longSid}`), `widget=${widget}`);
		assert.ok(!widget.includes(`#${shortSid}`), `widget=${widget}`);

		const drained = await h.call("write_stdin", { session_id: shortSid, chars: "", yield_time_ms: 5000 });
		assert.equal(drained.details.exit_code, 0, `details=${JSON.stringify(drained.details)}`);
		await h.call("kill_session", { session_id: longSid });
		await h.emit("session_shutdown");
	});

	it("session_shutdown terminates all live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 200 });
		assert.ok(r1.details.session_id);
		assert.ok(r2.details.session_id);
		await h.emit("session_shutdown");
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0);
	});

	it("session_shutdown racing exec_command creation does not orphan the child", async () => {
		// Regression: exec_command inserts into the store only AFTER the
		// 150ms early-exit grace; a shutdown inside that window used to drain
		// the store without seeing the new session, leaving the process alive
		// and untracked.
		const h = makeHarness();
		await h.emit("session_start");
		const inflight = h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 500 });
		await new Promise((r) => setTimeout(r, 40)); // inside the grace window
		await h.emit("session_shutdown");
		const r = await inflight;
		// Shutdown owns the pending session: the call never returns a session_id. It
		// reports the exit, or — where exit reporting outlasts shutdown's wait (Bun
		// Terminal on Windows after taskkill) — an explicit unconfirmed exit.
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		const reportedExit = r.details.exit_code != null || Boolean(r.details.signal);
		const unconfirmed = r.details.running === true && /exit not confirmed/.test(r.details.failure_message ?? "");
		assert.ok(reportedExit || unconfirmed, JSON.stringify(r.details));
		await h.emit("session_start");
		const l = await h.call("list_sessions", {});
		assert.deepEqual(l.details.sessions, [], JSON.stringify(l.details));
		await h.emit("session_shutdown");
	});

	it("a session in the grace window at shutdown never reaches the next session period", { skip: IS_WINDOWS }, async () => {
		// #66: the grace ended after shutdown had already drained the store, and
		// the session was inserted anyway, surviving into the next session_start.
		const marker = `30.${process.pid}${Date.now() % 1000}`;
		const h = makeHarness();
		await h.emit("session_start");
		const inflight = h.call("exec_command", { cmd: `trap '' TERM HUP; sleep ${marker}`, shell: "/bin/bash", yield_time_ms: 500 });
		await new Promise((r) => setTimeout(r, 40)); // inside the grace window
		await h.emit("session_shutdown");
		const r = await inflight;
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		assert.equal(r.details.signal, "SIGKILL", JSON.stringify(r.details));
		assert.equal(r.details.shell, "/bin/bash", JSON.stringify(r.details));
		await h.emit("session_start");
		const l = await h.call("list_sessions", {});
		assert.deepEqual(l.details.sessions, [], JSON.stringify(l.details));
		assert.throws(() => execFileSync("pgrep", ["-f", `slee[p] ${marker}`]), "trapping child must be dead");
		await h.emit("session_shutdown");
	});

	it("an in-flight write_stdin whose terminal shutdown released before the child died returns empty output", { skip: IS_WINDOWS }, async () => {
		// Shutdown releases the live terminal at once, but a child that ignores
		// SIGTERM dies only at the SIGKILL escalation 1 s later. A 500 ms
		// attachment window therefore ends while the child is alive, after the
		// release, and must not observe the released screen.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const h = makeHarness();
			await h.emit("session_start");
			const r1 = await h.call("exec_command", { cmd: "trap '' TERM HUP; echo trap-ready; sleep 30", yield_time_ms: 250 });
			const sid = r1.details.session_id;
			assert.ok(typeof sid === "number", JSON.stringify(r1.details));
			const logPath: string = r1.details.log_path;
			assert.ok(await waitFor(() => readFileSync(logPath, "utf8").includes("trap-ready")), "SIGTERM trap was not installed");
			const listed: Array<{ session_id: number; pid: number }> = (await h.call("list_sessions", {})).details.sessions;
			const pid = listed.find((s) => s.session_id === sid)?.pid;
			assert.ok(typeof pid === "number");

			const inflight = h.call("write_stdin", { session_id: sid, chars: "x", yield_time_ms: 500 });
			await h.emit("session_shutdown"); // releases the terminal now; returns after the SIGKILL escalation
			const r = await inflight;
			assert.equal(r.details.running, true, JSON.stringify(r.details));
			assert.equal(r.details.output, "");
			assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
			assert.deepEqual(unhandled.map(String), []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("exec_command is rejected after session_shutdown until the next session_start", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.emit("session_shutdown");
		await assert.rejects(() => h.call("exec_command", { cmd: "echo nope" }), /shutting down/);
		// A new session_start re-arms the extension (reload/new/resume).
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo back" });
		assert.equal(r.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
		it(`session_shutdown reason=${reason} terminates live sessions`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			const r = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
			assert.ok(r.details.session_id);
			await h.emit("session_shutdown", {
				type: "session_shutdown",
				reason,
				targetSessionFile: reason === "new" || reason === "resume" || reason === "fork" ? "/tmp/next.jsonl" : undefined,
			});
			const l = await h.call("list_sessions", {});
			assert.equal(l.details.active_count, 0);
		});
	}

	it("external abort breaks the yield but leaves session alive", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const ac = new AbortController();
		const promise = h.call(
			"exec_command",
			{ cmd: "sleep 10", yield_time_ms: 30_000 },
			ac.signal,
		);
		setTimeout(() => ac.abort(), 100);
		const t0 = Date.now();
		const r = await promise;
		const dt = Date.now() - t0;
		assert.ok(dt < 2000, `should have returned near abort time; dt=${dt}`);
		// Session should still be alive.
		assert.ok(typeof r.details.session_id === "number", `${JSON.stringify(r.details)}`);
		const sid = r.details.session_id;
		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.session_id === sid));
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("unknown session_id throws", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(
			() => h.call("write_stdin", { session_id: 9999, chars: "hi\n" }),
			/unknown session_id/,
		);
		await h.emit("session_shutdown");
	});

	it("kill_session on unknown id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("kill_session", { session_id: 9999 });
		assert.equal(r.details.found, false);
		await h.emit("session_shutdown");
	});

	it("response includes cwd, command, yield_time_ms in details and header", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo ok", yield_time_ms: 2000 });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.cwd, process.cwd());
		assert.equal(r.details.command, "echo ok");
		assert.equal(r.details.yield_time_ms, 2000);
		// cwd line appears in the LLM-visible header text
		assert.ok(r.content[0].text.includes(`cwd: ${process.cwd()}`), `cwd header missing: ${r.content[0].text}`);
		await h.emit("session_shutdown");
	});

	it("short command includes a persistent log_path in details", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello" });
		assert.equal(r.details.exit_code, 0);

		assert.ok(typeof r.details.log_path === "string" && r.details.log_path.length > 0, `log_path missing: ${JSON.stringify(r.details)}`);
		assert.ok(existsSync(r.details.log_path), `log file should exist: ${r.details.log_path}`);
		// log file should contain the full output verbatim.
		const logContent = readFileSync(r.details.log_path, "utf-8");
		assert.ok(logContent.includes("hello"), `log content: ${logContent}`);
		await h.emit("session_shutdown");
	});



	it("list_sessions entries include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 1);
		const entry = l.details.sessions[0];
		assert.equal(entry.session_id, r1.details.session_id);
		assert.equal(entry.log_path, r1.details.log_path);
		assert.ok(existsSync(entry.log_path));
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.emit("session_shutdown");
	});

	it("kill_session details include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const sid = r1.details.session_id;
		const r2 = await h.call("kill_session", { session_id: sid });
		assert.equal(r2.details.log_path, r1.details.log_path);
		await h.emit("session_shutdown");
	});

	it("invalid explicit and environment-selected shells fail without running a fallback", async () => {
		const previous = process.env.SHELL;
		const h = makeHarness();
		const missingShell = "definitely-not-a-real-shell-xyz";
		try {
			await h.emit("session_start");
			for (const explicit of [false, true]) {
				process.env.SHELL = explicit ? (IS_WINDOWS ? "cmd" : "/bin/sh") : missingShell;
				const args = {
					cmd: "echo fallback-must-not-run",
					...(explicit ? { shell: missingShell } : {}),
				};
				if (IS_WINDOWS) {
					// Resolution must reject before CreateProcess can fall back to
					// cwd-first executable lookup or a lower-priority interpreter.
					await assert.rejects(() => h.call("exec_command", args), /not found on PATH/);
				} else {
					const result = await h.call("exec_command", args);
					assert.equal(result.details.session_id, undefined, JSON.stringify(result.details));
					assert.equal(typeof result.details.failure_message, "string");
					assert.match(result.details.failure_message, /ENOENT/);
					assert.notEqual(result.details.exit_code, 0);
					assert.doesNotMatch(result.details.output, /fallback-must-not-run/);
					assertReportedShell(result, missingShell);
				}
				const listed = await h.call("list_sessions", {});
				assert.equal(listed.details.active_count, 0);
			}
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
			await h.emit("session_shutdown");
		}
	});

	it("nonexistent workdir surfaces a failure_message", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hi", workdir: "/definitely/not/a/real/dir" });
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		assert.ok(
			typeof r.details.failure_message === "string" && /ENOENT/.test(r.details.failure_message),
			`expected ENOENT failure_message; got ${JSON.stringify(r.details)}`,
		);
		await h.emit("session_shutdown");
	});


	it("kill_session normalizes signal names (lowercase, no SIG prefix)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 60", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid, signal: "term" });
		assert.equal(r2.details.session_id, sid);
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, JSON.stringify(r2.details));
		await h.emit("session_shutdown");
	});

	it("kill_session rejects unknown signal names instead of silently no-opping", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(() => h.call("kill_session", { session_id: 1, signal: "BOGUS" }), /unknown signal/);
		await h.emit("session_shutdown");
	});

	it("list_sessions reports just-exited sessions once with exit info, then removes them", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		// Wait for the observed exit (the running-sessions status clears), not a fixed delay.
		assert.ok(await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === undefined), "exit was not observed");

		const l1 = await h.call("list_sessions", {});
		assert.equal(l1.details.active_count, 0, JSON.stringify(l1.details));
		const entry = l1.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry, `exited session should be reported once: ${JSON.stringify(l1.details)}`);
		assert.equal(entry.running, false);
		assert.equal(entry.exit_code, 0);
		assert.ok(l1.content[0].text.includes("exited"), l1.content[0].text);

		const l2 = await h.call("list_sessions", {});
		assert.equal(l2.details.sessions.length, 0, JSON.stringify(l2.details));
		await h.emit("session_shutdown");
	});

	it("session_shutdown SIGKILLs children that trap SIGTERM", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "trap '' TERM; sleep 30", shell: "bash", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const l = await h.call("list_sessions", {});
		const pid = l.details.sessions.find((s: any) => s.session_id === sid)?.pid;
		assert.ok(typeof pid === "number");

		await h.emit("session_shutdown");
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
	});

	it("onUpdate streams growing partial output while running", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const updates: any[] = [];
		const r = await h.call(
			"exec_command",
			{ cmd: "for i in 1 2 3 4; do echo beat-$i; sleep 0.25; done", yield_time_ms: 1500 },
			undefined,
			(partial: any) => updates.push(partial),
		);
		assert.ok(updates.length >= 2, `expected >=2 partial updates; got ${updates.length}`);
		const first = updates[0];
		const last = updates[updates.length - 1];
		assert.ok(typeof first.details.output === "string");
		assert.ok(last.details.output.length >= first.details.output.length, "output should grow");
		assert.ok(last.details.output.includes("beat-1"), last.details.output);
		assert.ok(
			updates.every((u) => typeof u.details.session_id === "number"),
			"partial updates should carry session_id",
		);
		if (r.details.session_id !== undefined) {
			await h.call("kill_session", { session_id: r.details.session_id });
		}
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command kills a selected session", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("killed 1")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command can kill all sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await h.call("exec_command", { cmd: "sleep 31", yield_time_ms: 250 });

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith("Kill all")));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions notifies when there is nothing to kill", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("no live sessions")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});
});
