/**
 * End-to-end tests for unified-exec.
 *
 * Exercises the full tool pipeline by instantiating the extension with a stub
 * ExtensionAPI and calling the registered tools' `execute` functions directly.
 * Bypasses pi's event loop but uses the real SessionStore / ExecSession /
 * SpawnedChild code paths.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import extensionFactory, { MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";

// Process-tool harness: the fake API has no codemode surfaces (see codemode-render tests).
process.env.PI_UNIFIED_EXEC_COMPACT_CODEMODE = "0";

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
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
}

function makeHarness() {
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

	// run the factory synchronously
	(extensionFactory as any)(pi);

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

/** Poll until `cond` is true or the deadline passes (CI runners are slow). */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return cond();
}

const out = (o: unknown) => console.log("DIAG " + JSON.stringify(o));
async function exitTimeline(h: any, sid: number, t0: number, limitMs: number) {
  let firstOutput: number | undefined; let exited: any;
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const l = await h.call("list_sessions", {});
    const s = l.details.sessions.find((x: any) => x.session_id === sid);
    if (s && firstOutput === undefined && s.output_bytes_total > 16) firstOutput = Date.now() - t0;
    if (!s || s.running === false) { exited = { at: Date.now() - t0, exit_code: s?.exit_code, signal: s?.signal, reported: !!s }; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  return { firstOutput, exited };
}
describe("diag", () => {
  for (const cmd of ["exit 0", "echo start", "echo start; sleep 0.3; echo end"]) {
    it(`timing: ${cmd}`, async () => {
      const h = makeHarness(); await h.emit("session_start");
      const t0 = Date.now();
      const r = await h.call("exec_command", { cmd, yield_time_ms: 250 });
      const ret = Date.now() - t0;
      if (r.details.session_id === undefined) { out({ case: "timing", cmd, returned_exited_at: ret, exit_code: r.details.exit_code }); }
      else out({ case: "timing", cmd, returned_running_at: ret, ...(await exitTimeline(h, r.details.session_id, t0, 20000)) });
      await h.emit("session_shutdown");
    });
  }
  it("ctrl-d to cat", async () => {
    const h = makeHarness(); await h.emit("session_start");
    const t0 = Date.now();
    const r = await h.call("exec_command", { cmd: "stty -echo; printf 'ready\\n'; exec cat", yield_time_ms: 250 });
    const sid = r.details.session_id; const log = r.details.log_path;
    const has = (s: string) => { try { return readFileSync(log, "utf8").includes(s); } catch { return false; } };
    const ready = await waitFor(() => has("ready"), 20000); const readyAt = Date.now() - t0;
    await h.call("write_stdin", { session_id: sid, chars: "hello-cat\n", yield_time_ms: 250 });
    const echoed = await waitFor(() => has("hello-cat"), 10000);
    const tEof = Date.now();
    const w = await h.call("write_stdin", { session_id: sid, chars: "\x04", yield_time_ms: 250 });
    const wInfo = { at: Date.now() - tEof, exit_code: w.details.exit_code, signal: w.details.signal, still_session: w.details.session_id };
    const tl = await exitTimeline(h, sid, tEof, 20000);
    const raw = readFileSync(log, "utf8");
    out({ case: "ctrl-d", ready, readyAt, echoed, eof_write: wInfo, after_eof: tl, log_json: JSON.stringify(raw.slice(-600)) });
    await h.emit("session_shutdown");
  });
  it("noisy log fidelity", async () => {
    const h = makeHarness(); await h.emit("session_start");
    const r = await h.call("exec_command", { cmd: 'sleep 0.8; for i in $(seq 1 4000); do echo "kill-line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; sleep 60', yield_time_ms: 250 });
    const log = r.details.log_path;
    const done = await waitFor(() => { try { return readFileSync(log, "utf8").includes("kill-line-4000-"); } catch { return false; } }, 30000);
    await new Promise((res) => setTimeout(res, 1000));
    const raw = readFileSync(log, "utf8");
    const nums = new Set([...raw.matchAll(/kill-line-(\d+)-/g)].map((m) => Number(m[1])));
    const missing: number[] = []; for (let i = 1; i <= 4000; i++) if (!nums.has(i)) missing.push(i);
    const ranges: string[] = []; for (let i = 0; i < missing.length && ranges.length < 15; ) { let j = i; while (j + 1 < missing.length && missing[j + 1] === missing[j] + 1) j++; ranges.push(missing[i] === missing[j] ? `${missing[i]}` : `${missing[i]}-${missing[j]}`); i = j + 1; }
    const lines = raw.split("\n");
    const at = raw.indexOf("kill-line-2000-");
    out({ case: "noisy", done, bytes: Buffer.byteLength(raw), lines_startWith: lines.filter((l) => l.startsWith("kill-line-")).length,
      lines_contain: lines.filter((l) => l.includes("kill-line-")).length, distinct_numbers: nums.size, missing_count: missing.length, missing_ranges: ranges,
      head_json: JSON.stringify(raw.slice(0, 300)), around2000_json: JSON.stringify(raw.slice(Math.max(0, at - 200), at + 200)) });
    await h.call("kill_session", { session_id: r.details.session_id });
    await h.emit("session_shutdown");
  });
});
