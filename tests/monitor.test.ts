import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { MonitorSubscription, type MonitorSession } from "../fork-features/monitor-subscription.ts";
import { NoticeDispatcher, type NoticeMessage, type NoticeOutcome } from "../fork-features/terminal-notice.ts";
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
	const session = ExecSession.spawn(id, { title: "Test terminal", command: [process.execPath, "-e", "process.stdin.setRawMode(true); process.stdout.write('READY\\r\\n'); process.stdin.on('data', b => { if (b.toString().includes('EXIT')) process.stdout.write('LAST MATCH', () => process.exit(4)); else process.stdout.write(b.toString().replace(/\\n/g, '\\r\\n')); });"],
		cwd: process.cwd(), env: { ...process.env }, });
	const ready = await session.collect({ deadlineMs: Date.now() + 3000 });
	assert.equal(ready.kind, "screen");
	if (ready.kind === "screen" && ready.observation.kind === "rendered") assert.match(ready.observation.text, /READY/);
	return session;
}

/** Spawned without consuming an observation; READY seen on the live screen. */
async function readySession(id: number): Promise<ExecSession> {
	const session = ExecSession.spawn(id, { title: "Test terminal", command: [process.execPath, "-e", "process.stdin.setRawMode(true); process.stdout.write('READY\\r\\n'); process.stdin.on('data', b => process.stdout.write(b.toString().replace(/\\n/g, '\\r\\n')));"],
		cwd: process.cwd(), env: { ...process.env }, });
	for (let attempt = 0; attempt < 150 && !session.liveSnapshot()?.text.includes("READY"); attempt++) await delay(20);
	assert.match(session.liveSnapshot()?.text ?? "", /READY/);
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

	it("reports alternate-screen rows overwritten after a bare CR or a cursor move, once, across write boundaries", async () => {
		const enter = "\x1b[?1049h\x1b[H";
		// tmux redrawing a pane line by line with bare CRs: the marker is overwritten in the same parse.
		assert.deepEqual(await renderedDelta(40, 3, enter, "Setting up x ...\rAPT_EXIT=0\rprompt# "),
			["Setting up x ...", "APT_EXIT=0 x ...", "prompt# =0 x ..."]);
		assert.deepEqual(await renderedDelta(40, 3, enter, ["MARK=1\r", "overwritten"]), ["MARK=1", "overwritten"]);
		assert.deepEqual(await renderedDelta(40, 3, enter, "SAME\rSAME\rSAME"), ["SAME"], "an unchanged row is not reported again");
		assert.deepEqual(await renderedDelta(40, 3, enter, "line\r\nnext"), ["line", "next"], "CR LF needs no sample");
		// tmux returns to row 1 with CSI H, and to its bottom row with CSI row;1 H, LF and CSI A;
		// the row the LF scrolled in is blank where the marker was.
		assert.deepEqual(await renderedDelta(40, 3, enter, "MARK=2\x1b[Hoverwritten"), ["MARK=2", "overwritten"]);
		assert.deepEqual(await renderedDelta(40, 3, enter, "\x1b[3;1HMARK=3\x1b[3;1H\n\x1b[Aoverwritten"),
			["MARK=3", "", "overwritten"]);
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
		const delivered = Promise.withResolvers<NoticeMessage>();
		let attempts = 0;
		const coordinator = new CompletionCoordinator({ notices: new NoticeDispatcher({
			send: (message) => {
				if (++attempts === 1) { failed.resolve(); throw new Error("queue unavailable"); }
				delivered.resolve(message);
			},
			debounceMs: 5,
			onSendError: () => { throw new Error("UI also unavailable"); },
		}) });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		await coordinator.startMonitor(session, { condition: "MATCH", maxReturns: 1 });
		session.write(encoder.encode("MATCH one\n"));
		await failed.promise;
		assert.equal(coordinator.monitorStatus(session.id)?.returns, 0);
		coordinator.flushPending();
		const message = await delivered.promise;
		await delay(0);
		assert.equal(attempts, 2);
		const { body } = message.details.notices[0]!;
		assert.ok(body.kind === "monitor_match");
		assert.equal(body.monitor.returns, 0, "the payload describes returns before this delivery");
		assert.deepEqual(body.lines, ["MATCH one"]);
		assert.match(message.content, /limit reached/);
		assert.equal(coordinator.monitorStatus(session.id), undefined);
		const output = await session.collect({ deadlineMs: Date.now() });
		assert.ok(output.kind === "screen" && output.observation.kind === "rendered", `ordinary observation was consumed: ${JSON.stringify(output)}`);
		assert.match(output.observation.text, /MATCH one/);
	});

	it("merges final partial terminal output with End and consumes exactly the matching ordinary wake", async (t) => {
		const session = await terminalSession(9102);
		const delivered = Promise.withResolvers<NoticeMessage>();
		const messages: NoticeMessage[] = [];
		const coordinator = new CompletionCoordinator({ notices: new NoticeDispatcher({ send: (message) => {
			messages.push(message);
			delivered.resolve(message);
		}, debounceMs: 5 }) });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		coordinator.register(session);
		await coordinator.startMonitor(session, { condition: "MATCH" });
		session.write(encoder.encode("EXIT\n"));
		const message = await delivered.promise;
		await delay(0);
		coordinator.flushPending();
		await delay(300);
		const notices = messages.flatMap((item) => item.details.notices);
		assert.deepEqual(notices.map((notice) => notice.kind), ["monitor_end"]);
		const { body } = message.details.notices[0]!;
		assert.ok(body.kind === "monitor_end");
		assert.equal(body.exitCode, 4);
		assert.equal(body.monitor.returns, 0);
		assert.deepEqual(body.lines, ["LAST MATCH"]);
		assert.match(message.content, /LAST MATCH/);
		assert.equal(coordinator.monitorStatus(session.id), undefined);
	});

	it("reminds once per silent period with the current screen, and a delivered match starts a new period", async (t) => {
		const session = await readySession(9103);
		const messages: NoticeMessage[] = [];
		const coordinator = new CompletionCoordinator({ notices: new NoticeDispatcher({ send: (message) => { messages.push(message); }, debounceMs: 5 }) });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		const started = Date.now();
		const status = await coordinator.startMonitor(session, { condition: "MATCH", remindAfterMs: 600 });
		assert.equal(status.remind_after_ms, 600);
		await delay(350);
		session.write(encoder.encode("MATCH early\n"));
		await delay(600);
		// Without the restart the reminder would have fired at 600ms.
		assert.deepEqual(messages.flatMap((m) => m.details.notices).map((n) => n.kind), ["monitor_match"]);
		await delay(500);
		assert.deepEqual(messages.flatMap((m) => m.details.notices).map((n) => n.kind), ["monitor_match", "monitor_silent"]);
		const reminder = messages[1]!;
		const { body } = reminder.details.notices[0]!;
		assert.ok(body.kind === "monitor_silent");
		assert.ok(body.silentMs >= 600 && Date.now() - started >= 1200);
		assert.equal(body.monitor.returns, 1, "a reminder is not a return");
		assert.match(reminder.content, /has not returned for/);
		assert.match(reminder.content, /MATCH early/, "the reminder quotes the current screen");
		await delay(900);
		assert.deepEqual(messages.flatMap((m) => m.details.notices).map((n) => n.kind), ["monitor_match", "monitor_silent"], "one reminder per silent period");
		assert.deepEqual(coordinator.monitorStatus(session.id), { condition: "MATCH", returns: 1, max_returns: 10, remind_after_ms: 600 });
	});

	it("rejects an invalid remind_after_ms without replacing the existing monitor", async (t) => {
		const session = await readySession(9104);
		const coordinator = new CompletionCoordinator({ notices: new NoticeDispatcher({ send: () => {} }) });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		await coordinator.startMonitor(session, { condition: "KEEP" });
		for (const remindAfterMs of [0, 1.5, 2 ** 31]) {
			await assert.rejects(coordinator.startMonitor(session, { remindAfterMs }), /invalid_remind_after_ms/);
		}
		assert.deepEqual(coordinator.monitorStatus(session.id), { condition: "KEEP", returns: 0, max_returns: 10, remind_after_ms: 1_200_000 });
	});

	it("prefers pending matches over a due reminder and serializes End after an in-flight reminder", async () => {
		const fake: MonitorSession = {
			id: 1, title: "Pending monitor", hasExited: false, exitCode: null, signal: null, terminalUrl: "term://fake", logPath: "/tmp/fake.log",
			lastOutputAt: Date.now(), liveSnapshot: () => undefined, subscribeMonitor: async () => "accepted",
		};
		const sent: string[] = [];
		const reminderStarted = Promise.withResolvers<void>();
		const reminderDelivered = Promise.withResolvers<NoticeOutcome>();
		const matchStarted = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<void>();
		const finished: boolean[] = [];
		const subscription = new MonitorSubscription(fake, { kind: "regex", source: "M", regex: /M/ }, 10, 40,
			(notice) => {
				sent.push(notice.body.kind);
				if (notice.body.kind === "monitor_silent") {
					reminderStarted.resolve();
					return reminderDelivered.promise;
				}
				matchStarted.resolve();
				return Promise.resolve("delivered");
			},
			(sub, completed) => { finished.push(completed); sub.cancel(); ended.resolve(); }, () => true);
		subscription.startReminder();
		subscription.lines(["M pending"]);
		await matchStarted.promise;
		assert.deepEqual(sent, ["monitor_match"], "the reminder fell due while a match was pending");
		await reminderStarted.promise;
		assert.deepEqual(sent, ["monitor_match", "monitor_silent"]);
		subscription.end();
		assert.deepEqual(finished, [], "End waits for the already submitted notice");
		reminderDelivered.resolve("delivered");
		await ended.promise;
		assert.deepEqual(sent, ["monitor_match", "monitor_silent", "monitor_end"]);
		assert.deepEqual(finished, [true]);
		subscription.cancel();
	});
});

