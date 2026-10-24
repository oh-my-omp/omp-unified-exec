import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { MonitorMessage } from "../fork-features/monitor-subscription.ts";
import { CompletionCoordinator } from "../src/completion.ts";
import { ExecSession } from "../src/session.ts";
import { TerminalScreen, type TerminalLineSubscription } from "../src/terminal-screen.ts";
import { IS_WINDOWS } from "../src/shell.ts";

const encoder = new TextEncoder();

async function renderedDelta(cols: number, rows: number, before: string, after: string | readonly string[]): Promise<string[]> {
	const screen = new TerminalScreen(cols, rows, () => {});
	let handle: TerminalLineSubscription | undefined;
	const lines: string[] = [];
	try {
		screen.write(encoder.encode(before));
		await screen.project();
		assert.equal(await screen.subscribeLines(() => true, (batch) => lines.push(...batch), (source) => { handle = source; return true; }), "accepted");
		for (const chunk of typeof after === "string" ? [after] : after) screen.write(encoder.encode(chunk));
		await handle!.finish();
		return lines;
	} finally {
		handle?.cancel();
		await screen.release();
	}
}

async function terminalSession(id: number): Promise<ExecSession> {
	const session = ExecSession.spawn(id, {
		command: [process.execPath, "-e", "process.stdin.setRawMode(true); process.stdout.write('READY\\r\\n'); process.stdin.on('data', b => { if (b.toString().includes('EXIT')) process.stdout.write('LAST MATCH', () => process.exit(4)); else process.stdout.write(b.toString().replace(/\\n/g, '\\r\\n')); });"],
		cwd: process.cwd(), env: { ...process.env },
	});
	const ready = await session.collect({ deadlineMs: Date.now() + 3000 });
	assert.equal(ready.kind, "screen");
	if (ready.kind === "screen" && ready.observation.kind === "rendered") assert.match(ready.observation.text, /READY/);
	return session;
}

async function close(session: ExecSession): Promise<void> {
	session.kill("SIGKILL");
	await session.outputClosed.closed();
	await session.release();
}

describe("monitor source and delivery", () => {
	it("does not replay old screen survivors when a burst trims the first baseline row", async () => {
		const fresh = Array.from({ length: 481 }, (_, index) => `NEW${index}`);
		assert.deepEqual(await renderedDelta(500, 5, "OLD0\r\nOLD1\r\nOLD2\r\nOLD3\r\nOLD4", `\r\n${fresh.join("\r\n")}`), fresh);
	});

	it("joins changed wrapped rows and preserves distinct equal-text new lines", async () => {
		assert.deepEqual(await renderedDelta(5, 3, "", "1234KEYWORD"), ["1234KEYWORD"]);
		assert.deepEqual(await renderedDelta(20, 3, "", "same\r\nsame"), ["same", "same"]);
	});

	it("suppresses same-content erase/redraw but reports actual erased text", async () => {
		assert.deepEqual(await renderedDelta(20, 3, "STATIC\r\nNEXT", "\x1b[2J\x1b[HSTATIC\r\nNEXT"), []);
		assert.deepEqual(await renderedDelta(20, 3, "STATIC\r\nNEXT", "\x1b[2J"), ["", ""]);
		assert.deepEqual(await renderedDelta(20, 3, "", "\n"), [], "cursor-only movement is not a rendered text change");
		assert.deepEqual(await renderedDelta(20, 2, "", "\n\n"), [""], "a newly scrolled blank row has a new identity");
	});

	it("separates history erase, buffer reset and alternate-screen padding", async () => {
		const old = Array.from({ length: 20 }, (_, index) => `OLD${index}`).join("\r\n");
		assert.deepEqual(await renderedDelta(20, 3, old, "\x1b[3J"), []);
		assert.deepEqual(await renderedDelta(20, 3, old, "\x1bcRESET"), ["RESET"]);
		assert.deepEqual(await renderedDelta(20, 3, "OLD", "\x1b[?1049h\x1b[HALT"), ["ALT"]);
		assert.deepEqual(await renderedDelta(20, 3, "OLD\x1b[?1049h\x1b[HALT", "\x1b[?1049l\r\nNEW"), ["NEW"]);
	});

	it("reports alternate-screen rows overwritten after a bare CR, once, across write boundaries", async () => {
		const enter = "\x1b[?1049h\x1b[H";
		// tmux redrawing a pane line by line with bare CRs: the marker is overwritten in the same parse.
		assert.deepEqual(await renderedDelta(40, 3, enter, "Setting up x ...\rAPT_EXIT=0\rprompt# "),
			["Setting up x ...", "APT_EXIT=0 x ...", "prompt# =0 x ..."]);
		assert.deepEqual(await renderedDelta(40, 3, enter, ["MARK=1\r", "overwritten"]), ["MARK=1", "overwritten"]);
		assert.deepEqual(await renderedDelta(40, 3, enter, "SAME\rSAME\rSAME"), ["SAME"], "an unchanged row is not reported again");
		assert.deepEqual(await renderedDelta(40, 3, enter, "line\r\nnext"), ["line", "next"], "CR LF needs no sample");
	});

	it("rolls back an accepted source tap when its publication callback throws", async () => {
		const screen = new TerminalScreen(20, 3, () => {});
		let called = false;
		try {
			await assert.rejects(screen.subscribeLines(() => true, () => { called = true; }, () => { throw new Error("publication failed"); }), /publication failed/);
			screen.write(encoder.encode("MATCH"));
			await screen.project();
			await delay(80);
			assert.equal(called, false);
		} finally { await screen.release(); }
	});

	it("counts successful returns only and retries a failed batch without losing process output", async (t) => {
		const session = await terminalSession(9101);
		const failed = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<MonitorMessage>();
		let attempts = 0;
		const coordinator = new CompletionCoordinator({
			send: () => { throw new Error("unexpected ordinary wake"); },
			sendMonitor: (message) => {
				if (++attempts === 1) { failed.resolve(); throw new Error("queue unavailable"); }
				delivered.resolve(message);
			},
			onSendError: () => { throw new Error("UI also unavailable"); },
		});
		t.after(async () => { coordinator.shutdown(); await close(session); });
		await coordinator.startMonitor(session, "MATCH", 1);
		session.write(encoder.encode("MATCH one\n"));
		await failed.promise;
		assert.equal(coordinator.monitorStatus(session.id)?.returns, 0);
		coordinator.flushPending();
		const message = await delivered.promise;
		await delay(0);
		assert.equal(attempts, 2);
		assert.equal(message.details.returns, 1);
		assert.deepEqual(message.details.lines, ["MATCH one"]);
		assert.match(message.content, /limit reached/);
		assert.equal(coordinator.monitorStatus(session.id), undefined);
		const output = await session.collect({ deadlineMs: Date.now() });
		assert.ok(output.kind === "screen" && output.observation.kind === "rendered", `ordinary observation was consumed: ${JSON.stringify(output)}`);
		assert.match(output.observation.text, /MATCH one/);
	});

	it("merges final partial terminal output with End and consumes exactly the matching ordinary wake", async (t) => {
		const session = await terminalSession(9102);
		const delivered = Promise.withResolvers<MonitorMessage>();
		let ordinary = 0;
		let monitors = 0;
		const coordinator = new CompletionCoordinator({ send: () => { ordinary++; }, sendMonitor: (message) => { monitors++; delivered.resolve(message); } });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		coordinator.register(session);
		await coordinator.startMonitor(session, "MATCH");
		session.write(encoder.encode("EXIT\n"));
		const message = await delivered.promise;
		await delay(0);
		coordinator.flushPending();
		await delay(300);
		assert.equal(message.details.event, "end");
		assert.equal(message.details.exit_code, 4);
		assert.deepEqual(message.details.lines, ["LAST MATCH"]);
		assert.equal(message.details.returns, 0);
		assert.equal(monitors, 1);
		assert.equal(ordinary, 0);
		assert.equal(coordinator.monitorStatus(session.id), undefined);
	});
});

