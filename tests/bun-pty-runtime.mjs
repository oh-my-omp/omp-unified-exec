import assert from "node:assert/strict";

import { spawnChild } from "../src/pty.ts";
import { buildShellCommand, IS_WINDOWS } from "../src/shell.ts";

function collect(child, name, action) {
	const decoder = new TextDecoder();
	let output = "";
	const { promise, resolve, reject } = Promise.withResolvers();
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		reject(new Error(`${name} PTY runtime case timed out. Output: ${JSON.stringify(output)}`));
	}, 30_000);
	child.onData((chunk) => {
		output += decoder.decode(chunk, { stream: true });
		action?.(output, child);
	});
	child.onExit((exitCode, signal, failureMessage) => {
		clearTimeout(timer);
		output += decoder.decode();
		resolve({ output, exitCode, signal, failureMessage, processExited: child.processExited });
	});
	return promise;
}

async function runInteractiveCase() {
	const argument = 'value with spaces "quotes" 雪';
	const script = `
		process.stdout.write("PTY_START\\n");
		process.stdout.write("GEOMETRY=" + process.stdout.columns + "x" + process.stdout.rows + "\\n");
		process.stdout.write("ARG=" + JSON.stringify(process.argv[1]) + "\\n");
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", value => {
			process.stdout.write("VALUE=" + value.trim() + "\\n");
			process.stdout.write("PTY_END\\n");
			process.exit(0);
		});
	`;
	const child = spawnChild({
		command: ["node", "-e", script, argument],
		cwd: process.cwd(),
		env: process.env,
		cols: 100,
		rows: 40,
	});
	let sent = false;
	const result = await collect(child, "interactive", (output, activeChild) => {
		if (sent || !output.includes("PTY_START")) return;
		sent = true;
		// CR is the portable Enter key: Windows console input does not submit LF.
		assert.equal(activeChild.write(new TextEncoder().encode("runtime-test\r")), true);
	});
	assert.equal(result.exitCode, 0, result.output);
	assert.equal(result.signal, null, result.output);
	assert.equal(result.failureMessage, undefined, result.output);
	assert.equal(result.processExited, true);
	assert.match(result.output, /PTY_START\r?\n/);
	assert.match(result.output, /GEOMETRY=100x40\r?\n/);
	assert.ok(result.output.includes(`ARG=${JSON.stringify(argument)}`), result.output);
	assert.match(result.output, /VALUE=runtime-test\r?\n/);
	assert.match(result.output, /PTY_END\r?\n/);
}

async function runShellCase() {
	const shell = IS_WINDOWS
		? (process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`)
		: "/bin/sh";
	const shellCommand = buildShellCommand(shell, "echo SHELL_OK");
	const child = spawnChild({
		...shellCommand,
		cwd: process.cwd(),
		env: process.env,
		cols: 90,
		rows: 30,
	});
	const result = await collect(child, "shell");
	assert.equal(result.exitCode, 0, result.output);
	assert.equal(result.signal, null, result.output);
	assert.equal(result.failureMessage, undefined, result.output);
	assert.equal(result.processExited, true);
	assert.match(result.output, /SHELL_OK/);
}

async function runRapidExitCase() {
	const child = spawnChild({
		command: ["node", "-e", ""],
		cwd: process.cwd(),
		env: process.env,
		cols: 80,
		rows: 24,
	});
	const result = await collect(child, "rapid-exit");
	assert.equal(result.exitCode, 0, result.output);
	assert.equal(result.signal, null, result.output);
	assert.equal(result.failureMessage, undefined, result.output);
	assert.equal(result.processExited, true);
}


async function runKillCase() {
	const script = `process.stdout.write("KILL_READY\\n"); setInterval(() => {}, 1000);`;
	const child = spawnChild({
		command: ["node", "-e", script],
		cwd: process.cwd(),
		env: process.env,
		cols: 80,
		rows: 24,
	});
	let killed = false;
	const result = await collect(child, "kill", (output, activeChild) => {
		if (killed || !output.includes("KILL_READY")) return;
		killed = true;
		activeChild.kill("SIGTERM");
	});
	assert.equal(result.processExited, true);
	assert.equal(result.failureMessage, undefined, result.output);
	assert.match(result.output, /KILL_READY\r?\n/);
	assert.ok(result.signal !== null || result.exitCode !== 0, JSON.stringify(result));
}

async function runProcessGroupKillCase() {
	if (IS_WINDOWS) return;
	const child = spawnChild({
		command: ["/bin/sh", "-c", "trap '' HUP; sleep 60 & pid=$!; echo GROUP_READY=$pid; wait"],
		cwd: process.cwd(),
		env: process.env,
		cols: 80,
		rows: 24,
	});
	let killed = false;
	let descendantPid;
	const result = await collect(child, "process-group-kill", (output, activeChild) => {
		const match = /GROUP_READY=(\d+)\r?\n/.exec(output);
		if (killed || !match) return;
		killed = true;
		descendantPid = Number(match[1]);
		activeChild.kill("SIGTERM");
	});
	assert.equal(result.processExited, true);
	assert.equal(result.failureMessage, undefined, result.output);
	assert.ok(descendantPid, result.output);

	const deadline = Date.now() + 3000;
	let descendantAlive = true;
	while (descendantAlive && Date.now() < deadline) {
		try {
			process.kill(descendantPid, 0);
			await Bun.sleep(25);
		} catch {
			descendantAlive = false;
		}
	}
	if (descendantAlive) {
		try {
			process.kill(descendantPid, "SIGKILL");
		} catch {
			descendantAlive = false;
		}
	}
	assert.equal(descendantAlive, false, `descendant ${descendantPid} survived PTY process-group kill`);
}

await runInteractiveCase();
await runShellCase();
await runRapidExitCase();
await runKillCase();
await runProcessGroupKillCase();
console.log(`Bun PTY runtime passed on ${process.platform}-${process.arch}`);
