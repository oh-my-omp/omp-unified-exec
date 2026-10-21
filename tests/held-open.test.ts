/**
 * Held-open result rendering and foreground shell lifecycle.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { NO_OUTPUT } from "../src/collect.ts";
import { ExecSession, type SessionSpawnOptions } from "../src/session.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { finalizeProcessResult, renderProcessResultText } from "../src/tool-result.ts";

const HELD_OPEN_NOTE = "shell has exited, but background process(es) still hold the terminal";

function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const poll = () => {
			if (cond() || Date.now() >= deadline) return resolve(cond());
			setTimeout(poll, 50);
		};
		poll();
	});
}

let nextId = 1000;

function spawnShell(cmd: string, workdir: string): ExecSession {
	const opts: SessionSpawnOptions = {
		command: ["bash", "-c", cmd],
		cwd: workdir,
		env: process.env,
	};
	const session = ExecSession.spawn(nextId++, opts);
	assert.equal(session.failureMessage, null, "spawn must succeed");
	return session;
}

/** Kill the whole process group and wait for the close-based exit. */
async function cleanup(session: ExecSession): Promise<void> {
	session.kill("SIGKILL");
	await waitFor(() => session.hasExited, 5000);
}

describe("held-open session diagnostics", { skip: IS_WINDOWS }, () => {
	const workdir = mkdtempSync(join(tmpdir(), "held-open-"));
	after(() => rmSync(workdir, { recursive: true, force: true }));




	it("normal foreground process: shellExited stays false while it runs", async () => {
		const session = spawnShell("sleep 2", workdir);
		try {
			assert.equal(session.shellExited, false, "shell is alive while the command runs");
			assert.equal(session.hasExited, false);
			assert.equal(await waitFor(() => session.hasExited, 5000), true, "exits normally when done");
			assert.equal(session.shellExited, true);
		} finally {
			await cleanup(session);
		}
	});

	it("render: held-open sessions carry the explanatory note, exited sessions do not", () => {
		const running = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 1,
			collected: NO_OUTPUT,
			sessionId: 7,
			exitCode: undefined,
			signal: null,
			failure: null,
			extra: { note: HELD_OPEN_NOTE },
		});
		const runningText = renderProcessResultText(running);
		assert.match(runningText, /\[still running\]/);
		assert.match(runningText, /note: shell has exited, but background process/);

		const exited = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 0.1,
			collected: NO_OUTPUT,
			sessionId: undefined,
			exitCode: 0,
			signal: null,
			failure: null,
		});
		const exitedText = renderProcessResultText(exited);
		assert.match(exitedText, /\[exited\]/);
		assert.doesNotMatch(exitedText, /note:/);
	});


});
