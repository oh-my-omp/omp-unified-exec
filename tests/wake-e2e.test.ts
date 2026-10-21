/**
 * Integration tests for input-bearing observation and exec_command's
 * `on_exit: "wake"` through the real tool pipeline.
 *
 * Uses a stub ExtensionAPI that captures pi.sendMessage calls and can emit
 * tool_execution_end / agent_settled lifecycle events. Subprocess-based tests
 * are kept small and cross-platform (sleep/echo through the default shell).
 */

import { strict as assert } from "node:assert";
import { readTerminal } from "../fork-features/terminal-resource.ts";
import { afterEach, describe, it } from "node:test";
import { activate, EmptyPollRemovedError } from "../src/index.ts";


interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
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
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
	};

	// The fake supplies only the ExtensionAPI surfaces consumed by the tool core.
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api);

	let nextCallId = 1;
	let shutDown = false;
	const harness = {
		/** Call a tool with a fresh toolCallId; returns { result, toolCallId }. */
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `call-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, signal, onUpdate, stubCtx);
			return { ...result, toolCallId };
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
			if (event === "session_shutdown") shutDown = true;
		},
		/** Simulate pi finalizing a tool result. */
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "", result: {}, isError });
		},
		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			try {
				await this.emit("session_shutdown");
			} catch {
				// best-effort cleanup
			}
		},
		sentMessages,
		uiEvents,
	};
	liveHarnesses.add(harness);
	return harness;
}

const liveHarnesses = new Set<{ shutdown: () => Promise<void> }>();

afterEach(async () => {
	const hs = [...liveHarnesses];
	liveHarnesses.clear();
	for (const h of hs) await h.shutdown();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


describe("exec_command on_exit", () => {
	it("omitted or explicit 'none' preserves current behavior (no wake)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const r2 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "none" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(typeof r2.details.session_id === "number");
		assert.equal(r2.details.completion_notification, undefined);
		await new Promise((r) => setTimeout(r, 1200)); // both exit + debounce window
		assert.equal(h.sentMessages.length, 0);
		// Reap the completed sessions through the inventory, not the write surface.
		await h.call("list_sessions", {});
		await h.emit("session_shutdown");
	});

	it("wake process exiting inside the initial exec_command yield gives a direct result, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo quick", yield_time_ms: 5000, on_exit: "wake" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("backgrounded wake session exiting while idle sends exactly one follow-up prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Output ("BYE") deliberately differs from the command text ("bye") so we
		// can assert the wake carries command metadata but never raw stdout.
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.4 && echo bye | tr a-z A-Z",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		assert.equal(r1.details.completion_notification, "armed");
		assert.equal(r1.details.on_exit, "wake");
		assert.ok(r1.content[0].text.includes("completion_notification: armed"), r1.content[0].text);

		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "unified-exec-completed");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /exit_code=0/);
		assert.ok(!message.content.includes("BYE"), "wake must not contain raw stdout");
		assert.ok(message.content.includes(`read ${r1.details.terminal_url}`));
		assert.doesNotMatch(message.content, /write_stdin/);

		// After the wake, the exited session's output is still retrievable…
		const projection = await readTerminal(r1.details.terminal_url.slice(7));
		assert.ok(projection.screenLines.some((line) => line.includes("BYE")));
		// Reading leaves the notification count unchanged.
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.emit("session_shutdown");
	});

	it("exit during an input-bearing observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "x", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.completion_delivery, "direct");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});


	it("input attachment window first, then exit: wake remains armed exactly once", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "x", yield_time_ms: 250 });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1, "exactly one");
		const r3 = await h.call("list_sessions", {});
		assert.equal(r3.details.sessions.find((s: { session_id: number }) => s.session_id === sid)?.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("rejected zero-byte input keeps the wake armed; later exit sends exactly one wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await assert.rejects(h.call("write_stdin", { session_id: sid }), EmptyPollRemovedError);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.call("list_sessions", {});
		await h.emit("session_shutdown");
	});

	it("a terminal result finalized as error keeps the completion wake-eligible", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "x", yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		// Pi finalizes the constructed result as an error → wake must fire.
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake despite constructed result");
		await h.emit("session_shutdown");
	});

	it("set_on_exit none disarms wake; failed job exit does not resume the agent", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.8; exit 1",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("set_on_exit", { session_id: sid, on_exit: "none" });
		assert.equal(r2.details.status, "disarmed");
		assert.equal(r2.details.wake_armed, false);
		// Wait until the process is gone (list reaps it) then confirm no wake.
		assert.ok(
			await waitFor(async () => {
				const l = await h.call("list_sessions", {});
				return l.details.active_count === 0;
			}),
			"process should exit",
		);
		// Debounce window after exit — still no wake.
		await sleep(400);
		assert.equal(h.sentMessages.length, 0, "disarmed wake must not fire");
	});

	it("set_on_exit wake arms a session started with on_exit none", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.5; exit 0",
			yield_time_ms: 250,
			on_exit: "none",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.equal(r2.details.status, "armed");
		assert.equal(r2.details.wake_armed, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "armed session should wake");
		await h.call("list_sessions", {});
	});

	it("set_on_exit unknown session_id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("set_on_exit", { session_id: 99999, on_exit: "none" });
		assert.equal(r.details.found, false);
	});

	it("list_sessions reports wake_armed for live wake sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const l = await h.call("list_sessions", {});
		const entry = l.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry);
		assert.equal(entry.wake_armed, true);
		assert.match(l.content[0].text, /wake/);
		await h.call("kill_session", { session_id: sid });
	});

	it("explicit model kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await h.call("kill_session", { session_id: sid });
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("human slash-command kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("list_sessions observing the exit before notification suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		// Poll until list_sessions can reap the exit (race with debounce).
		let entry: any;
		assert.ok(
			await waitFor(async () => {
				const l = await h.call("list_sessions", {});
				entry = l.details.sessions.find((s: any) => s.session_id === sid);
				return entry && entry.running === false;
			}),
			"expected list_sessions to observe exit",
		);
		await sleep(400); // remaining debounce budget if any
		assert.ok(h.sentMessages.length <= 1, `never more than one notification; got ${h.sentMessages.length}`);
	});

	it("session_shutdown cancels pending wakes (no stale prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Shut down before the process exits / the debounce fires.
		await h.emit("session_shutdown");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 800)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("several wake sessions finishing together produce one bounded batch", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Both processes block on the same marker file so their exits land within
		// a few tens of ms of each other — inside the wake debounce window.
		const marker = `${process.env.TMPDIR || "/tmp"}/unified-exec-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const waitCmd = `while [ ! -f "${marker}" ]; do sleep 0.05; done`;
		const a = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const b = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const release = await h.call("exec_command", { cmd: `touch "${marker}"`, yield_time_ms: 5000 });
		assert.equal(release.details.exit_code, 0);
		assert.ok(typeof a.details.session_id === "number");
		assert.ok(typeof b.details.session_id === "number");
		assert.ok(await waitFor(() => h.sentMessages.length >= 1), "batch wake expected");
		await new Promise((res) => setTimeout(res, 800));
		assert.equal(h.sentMessages.length, 1, "one prompt for both completions");
		const content = h.sentMessages[0].message.content;
		assert.match(content, new RegExp(`session_id=${a.details.session_id}`));
		assert.match(content, new RegExp(`session_id=${b.details.session_id}`));
		await h.call("write_stdin", { session_id: a.details.session_id, yield_time_ms: 5000 });
		await h.call("write_stdin", { session_id: b.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});

	it("agent_settled flushes a wake whose send previously failed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Make the first send throw.
		const originalPush = h.sentMessages.push.bind(h.sentMessages);
		let failures = 1;
		(h.sentMessages as any).push = (...args: any[]) => {
			if (failures > 0) {
				failures--;
				throw new Error("synthetic send failure");
			}
			return originalPush(...args);
		};
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Wait until the exit's first send attempt has actually failed, not a fixed delay.
		assert.ok(await waitFor(() => failures === 0), "first send attempt never happened");
		assert.equal(h.sentMessages.length, 0);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "retry at agent_settled");
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
	});
});
