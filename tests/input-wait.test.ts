import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { detectInputPrompt, inputWaitNotice, type InputPrompt, type InputWaitAlert } from "../fork-features/input-wait.ts";
import { buildNoticeMessage, NoticeDispatcher, type NoticeMessage } from "../fork-features/terminal-notice.ts";
import { CompletionCoordinator } from "../src/completion.ts";
import { ExecSession } from "../src/session.ts";
import { TerminalScreen } from "../src/terminal-screen.ts";

const encoder = new TextEncoder();

async function detect(cols: number, rows: number, bytes: string): Promise<InputPrompt | undefined> {
	const screen = new TerminalScreen(cols, rows, () => {});
	try {
		screen.write(encoder.encode(bytes));
		await screen.project();
		const probe = screen.inputProbe();
		assert.ok(probe);
		return detectInputPrompt(probe);
	} finally {
		await screen.release();
	}
}

/** The debconf/ucf question openssh-server asks about sshd_config, as whiptail draws it. */
const WHIPTAIL = [
	"\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J",
	"\x1b[1;1HPackage configuration",
	"\x1b[3;3H┌──────────┤ Modified configuration file ├──────────┐",
	"\x1b[4;3H│ What do you want to do about modified configuration file sshd_config? │",
	"\x1b[6;3H│      install the package maintainer's version      │",
	"\x1b[7;3H│      keep the local version currently installed    │",
	"\x1b[9;3H│                      <Ok>                          │",
	"\x1b[10;3H└───────────────────────────────────────────────────┘",
	"\x1b[7;10H",
].join("");

describe("input prompt detection", () => {
	it("recognizes a whiptail dialog anywhere on the screen and drops its frame", async () => {
		const prompt = await detect(100, 12, WHIPTAIL);
		assert.equal(prompt?.kind, "dialog");
		assert.ok(prompt.lines.includes("Modified configuration file"));
		assert.ok(prompt.lines.includes("What do you want to do about modified configuration file sshd_config?"));
		assert.ok(prompt.lines.includes("<Ok>"));
	});

	it("recognizes prompts that end at the cursor", async () => {
		for (const [bytes, line] of [
			["Need to get 10 MB.\r\nDo you want to continue? [Y/n] ", "Do you want to continue? [Y/n]"],
			["*** sshd_config (Y/I/N/O/D/Z) [default=N] ? ", "*** sshd_config (Y/I/N/O/D/Z) [default=N] ?"],
			["[sudo] password for ops: ", "[sudo] password for ops:"],
			["Are you sure you want to continue connecting (yes/no/[fingerprint])? ", "Are you sure you want to continue connecting (yes/no/[fingerprint])?"],
			["Press ENTER to continue", "Press ENTER to continue"],
		] as const) {
			const prompt = await detect(120, 6, bytes);
			assert.equal(prompt?.kind, "inline", bytes);
			assert.equal(prompt.lines.at(-1), line);
		}
	});

	it("joins a prompt wrapped across rows", async () => {
		const prompt = await detect(20, 6, "Remove 12 packages and continue? [y/N] ");
		assert.equal(prompt?.kind, "inline");
		assert.equal(prompt.lines.at(-1), "Remove 12 packages and continue? [y/N]");
	});

	it("recognizes a pager waiting on the bottom row", async () => {
		const prompt = await detect(40, 4, "one\r\ntwo\r\nthree\r\n(END)");
		assert.equal(prompt?.kind, "pager");
		assert.deepEqual(prompt.lines, ["one", "two", "three", "(END)"]);
	});

	it("ignores shells, progress, answered prompts and prompts away from the cursor", async () => {
		for (const bytes of [
			"user@host:~$ ",
			"Downloading 45%",
			"Do you want to continue? [Y/n] y\r\nReading package lists...",
			"Overwrite (yes/no)? \r\n",
			"(END) mentioned in a log\r\nstill working",
			"three\r\n(END)\r\n\r\n",
		]) {
			assert.equal(await detect(80, 6, bytes), undefined, bytes);
		}
	});
});

const PROMPTER = [
	"process.stdin.setRawMode(true);",
	"setTimeout(() => process.stdout.write('Proceed? [Y/n] '), 50);",
	"process.stdin.on('data', () => setTimeout(() => process.stdout.write('\\r\\nNext? [y/N] '), 50));",
].join("");

function prompter(id: number, alerts: InputWaitAlert[]): ExecSession {
	return ExecSession.spawn(id, { title: "Test terminal", command: [process.execPath, "-e", PROMPTER],
		cwd: process.cwd(), env: { ...process.env },
		inputWait: { quietMs: 150, onAlert: (alert) => alerts.push(alert) }, });
}

async function close(session: ExecSession): Promise<void> {
	session.kill("SIGKILL");
	await session.outputClosed.closed();
	await session.release();
}

describe("session input-wait alerts", () => {
	it("alerts once for an unseen prompt, again for a new prompt, and goes stale once a result shows it", async (t) => {
		const alerts: InputWaitAlert[] = [];
		const session = prompter(9201, alerts);
		t.after(() => close(session));
		await delay(600);
		assert.equal(alerts.length, 1, "one alert per prompt screen");
		const [first] = alerts;
		assert.equal(first!.notice.body.kind, "input_wait");
		assert.ok(first!.notice.body.kind === "input_wait");
		assert.equal(first!.notice.body.prompt, "inline");
		assert.deepEqual(first!.notice.body.lines, ["Proceed? [Y/n]"]);
		assert.match(buildNoticeMessage([first!.notice]).content, /appears to be waiting for input/);
		assert.equal(first!.notice.identity.sessionId, 9201);
		assert.equal(first!.current(), true);

		session.write(encoder.encode("y"));
		await delay(600);
		assert.equal(alerts.length, 2);
		assert.equal(first!.current(), false, "a newer screen replaces the old alert");
		assert.ok(alerts[1]!.notice.body.kind === "input_wait");
		assert.deepEqual(alerts[1]!.notice.body.lines.at(-1), "Next? [y/N]");

		await session.collect({ deadlineMs: Date.now() });
		assert.equal(alerts[1]!.current(), false, "a consuming observation showed the prompt");
	});

	it("stays silent when the attached tool result shows the prompt", async (t) => {
		const alerts: InputWaitAlert[] = [];
		const session = prompter(9202, alerts);
		t.after(() => close(session));
		const result = await session.collect({ deadlineMs: Date.now() + 500 });
		assert.ok(result.kind === "screen" && result.observation.kind === "rendered");
		assert.match(result.observation.text, /Proceed\? \[Y\/n\]/);
		await delay(500);
		assert.equal(alerts.length, 0);
	});

	it("alerts through the coordinator while a non-matching monitor watches the same session", async (t) => {
		const delivered: NoticeMessage[] = [];
		const coordinator = new CompletionCoordinator({ notices: new NoticeDispatcher({ send: (message) => { delivered.push(message); }, debounceMs: 5 }) });
		const session = ExecSession.spawn(9203, { title: "Test terminal", command: [process.execPath, "-e", PROMPTER],
			cwd: process.cwd(), env: { ...process.env },
			inputWait: { quietMs: 150, onAlert: (alert) => coordinator.alertInputWait(alert) }, });
		t.after(async () => { coordinator.shutdown(); await close(session); });
		await coordinator.startMonitor(session, { condition: "NEVER_PRINTED" });
		await delay(600);
		assert.deepEqual(delivered.flatMap((m) => m.details.notices).map(({ body }) => {
			assert.ok(body.kind === "input_wait");
			return body.lines.at(-1);
		}), ["Proceed? [Y/n]"]);
		assert.equal(coordinator.monitorStatus(session.id)?.returns, 0);
	});
});

describe("input-wait delivery", () => {
	it("retries a failed alert at the next flush and drops one whose screen is no longer current", async () => {
		const sent: NoticeMessage[] = [];
		let fail = true;
		const errors: unknown[] = [];
		const notices = new NoticeDispatcher({
			send: (message) => {
				if (fail) { fail = false; throw new Error("queue unavailable"); }
				sent.push(message);
			},
			onSendError: (error) => errors.push(error),
		});
		const coordinator = new CompletionCoordinator({ notices });
		const notice = (id: number) => inputWaitNotice({
			sessionId: id, title: `Prompt ${id}`, command: "ask",
			prompt: { kind: "inline", lines: [`alert ${id}`] }, screen: "normal", quietMs: 5000,
			terminalUrl: `term://${id}`, logPath: "/tmp/x.log",
		});
		let current = true;
		coordinator.alertInputWait({ notice: notice(1), current: () => true });
		coordinator.flushPending();
		assert.equal(errors.length, 1);
		coordinator.flushPending();
		await Promise.resolve();
		assert.deepEqual(sent.flatMap((m) => m.details.notices).map((n) => n.session_id), [1]);
		assert.match(sent[0]!.content, /alert 1/);
		coordinator.flushPending();
		assert.equal(sent.length, 1, "a delivered alert is not sent again");

		fail = true;
		coordinator.alertInputWait({ notice: notice(2), current: () => current });
		coordinator.flushPending();
		assert.equal(errors.length, 2);
		current = false;
		coordinator.flushPending();
		assert.equal(sent.length, 1, "a stale alert is dropped");
		coordinator.shutdown();
	});
});
