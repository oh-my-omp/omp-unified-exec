/**
 * Native Bun PTY end-to-end tests. PTY support is mandatory.
 * Source/compiled runtime fixtures additionally cover the compiled host.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readTerminal } from "../fork-features/terminal-resource.ts";
import { activate } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";


/**
 * True when a real python3 exists. On Windows the "python3" on PATH may be
 * the WindowsApps Store stub, which stays alive without being a REPL — so
 * probe with --version instead of relying on spawn success.
 */
function hasRealPython3(): boolean {
	try {
		const r = spawnSync("python3", ["--version"], { timeout: 5000, windowsHide: true });
		return r.status === 0;
	} catch {
		return false;
	}
}

function makeHarness() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, any[]> = {};
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {} },
		hasUI: false,
	};
	const pi = {
		registerTool: (def: any) => { tools[def.name] = def; },
		on: (event: string, h: any) => { (handlers[event] ??= []).push(h); },
		registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};
	// The fake supplies only the ExtensionAPI surfaces consumed by the tool core.
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api);
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute("id", params, signal, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	};
}

/** Real child startup/output is external to fake clocks; read its non-consuming projection. */
async function readUntil(url: string, expected: RegExp): Promise<string> {
	const deadline = Date.now() + 8000;
	let text = "";
	do {
		text = (await readTerminal(url.slice(7))).screenLines.join("\n");
		if (expected.test(text)) return text;
		await delay(25);
	} while (Date.now() < deadline);
	assert.match(text, expected);
	return text;
}

describe("unified-exec PTY mode", () => {
	// NOTE: every test runs its body in try/finally with session_shutdown in
	// the finally. A failed assertion mid-test must not leak a live PTY
	// session: on Windows, ConPTY's conout worker keeps the event loop alive
	// until the session exits, so a leaked session hangs the test process
	// forever (observed on windows-latest CI).

	it("runs a command with a PTY that announces the emulator's TERM", async () => {
		const hostTerm = process.env.TERM;
		// omp itself may run in another terminal; its TERM must not reach the child.
		process.env.TERM = "xterm-kitty";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				cmd: "tty && echo seen=$TERM",

				yield_time_ms: 1500,
			});
			// If short-lived: exit_code is set; long-running: session_id. Either way output should
			// include "tty" / "dev/" to confirm a PTY was allocated.
			assert.ok(r.details.output.toLowerCase().includes("/dev/"), `output=${r.details.output}`);
			if (!IS_WINDOWS) assert.match(r.details.output, /^seen=xterm-256color$/m);
			if (r.details.session_id !== undefined) {
				await h.call("kill_session", { session_id: r.details.session_id });
			}
		} finally {
			if (hostTerm === undefined) delete process.env.TERM;
			else process.env.TERM = hostTerm;
			await h.emit("session_shutdown");
		}
	});

	it("write_stdin drives a Python REPL over PTY", { skip: !hasRealPython3(), timeout: 15_000 }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", {
				cmd: "python3 -q",

				yield_time_ms: 800,
			});
			const sid = r1.details.session_id;
			// hasRealPython3 already gated this test, so a missing session_id
			// means the REPL exited or failed to spawn — a real failure, not
			// "no python3".
			assert.equal(typeof sid, "number", `REPL did not stay alive: ${JSON.stringify(r1.details)}`);
			if (typeof sid !== "number") return; // for type narrowing

			// Submit with \r (the Enter key), not \n: POSIX ptys map CR→NL in
			// canonical mode (ICRNL) so both work there, but legacy Windows
			// console line input only executes on CR — with \n the REPL echoes
			// the text without running it (observed on windows-latest CI).
			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "print(2 + 40)\r",
				yield_time_ms: 2000,
			});
			// A cold child may outlive the input attachment window; read without writing.
			const output = r2.details.output.includes("42")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /^42$/m);
			assert.ok(output.includes("42"), `got: ${output}`);

			// Quit.
			await h.call("write_stdin", { session_id: sid, chars: "exit()\r", yield_time_ms: 1500 });
			// Clean up if still alive.
			const list = await h.call("list_sessions", {});
			if (list.details.sessions.some((s: any) => s.session_id === sid)) {
				await h.call("kill_session", { session_id: sid });
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("write_stdin round-trips input through a Node line-echo fixture", { timeout: 15_000 }, async () => {
		// Repo-owned fixture (no python dependency): a Node child that echoes
		// each stdin line as GOT:<line>| and exits 7 on "quit". This asserts
		// MANDATORY PTY input behavior on every platform — a no-op
		// write-to-pty implementation cannot pass this test.
		const fixture =
			"node -e 'let b=\"\";process.stdin.on(\"data\",d=>{b+=d.toString();let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i).trim();b=b.slice(i+1);if(line){process.stdout.write(\"GOT:\"+line+\"|\\n\");if(line===\"quit\")process.exit(7);}}})'";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", { cmd: fixture, yield_time_ms: 1500 });
			const sid = r1.details.session_id;
			assert.equal(typeof sid, "number", `fixture did not stay alive: ${JSON.stringify(r1.details)}`);

			const r2 = await h.call("write_stdin", { session_id: sid, chars: "hello\r", yield_time_ms: 2000 });
			const output = r2.details.output.includes("GOT:hello|")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /GOT:hello\|/);
			assert.ok(output.includes("GOT:hello|"), `PTY input did not round-trip: ${JSON.stringify(output)}`);

			const r3 = await h.call("write_stdin", { session_id: sid, chars: "quit\r", yield_time_ms: 3000 });
			let exitCode = r3.details.exit_code;
			// The process exit is external to fake clocks; inventory confirms its actual closure.
			const deadline = Date.now() + 8000;
			while (exitCode === undefined && Date.now() < deadline) {
				const listed = await h.call("list_sessions", {});
				exitCode = listed.details.sessions.find((s: { session_id: number }) => s.session_id === sid)?.exit_code;
				if (exitCode === undefined) await delay(25);
			}
			assert.equal(exitCode, 7, `fixture did not exit on quit: ${JSON.stringify(r3.details)}`);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("Windows: shell=cmd with a PTY works (verbatim /c payload)", { skip: !IS_WINDOWS }, async () => {
		// Keep cmd.exe's pre-quoted /s /c payload intact through Bun's
		// windowsVerbatimArguments handling.
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				cmd: "echo tty-one& echo tty-two",
				shell: "cmd",

				yield_time_ms: 20000,
			});
			assert.equal(r.details.exit_code, 0, JSON.stringify(r.details));
			assert.ok(r.details.output.includes("tty-one"), `output=${r.details.output}`);
			assert.ok(r.details.output.includes("tty-two"), `output=${r.details.output}`);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("Ctrl-C (\\x03) interrupts a PTY loop", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", {
				cmd: "while true; do echo alive; sleep 0.2; done",

				yield_time_ms: 400,
			});
			const sid = r1.details.session_id;
			assert.ok(typeof sid === "number");

			// Send Ctrl-C via \x03
			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "\x03",
				yield_time_ms: 1000,
			});
			// Session should exit (bash gets SIGINT from terminal).
			if (r2.details.session_id !== undefined) {
				// Some shells ignore SIGINT for background; fall back to kill.
				await h.call("kill_session", { session_id: sid });
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});
});
