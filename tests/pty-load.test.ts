/** Bun host admission and native PTY callback lifecycle guards. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { requireBunRuntime, spawnBunPty } from "../src/pty.ts";

type FakeTerminal = {
	closed: boolean;
	write(): number;
	close(): void;
};

type FakeSubprocess = {
	pid: number;
	terminal: FakeTerminal;
	kill(): void;
};

type FakeBunSpawnOptions = {
	terminal: {
		data(terminal: FakeTerminal, data: Uint8Array): void;
		exit(
			terminal: FakeTerminal,
			exitCode: number | null,
			signalCode: number | string | null,
			error?: Error,
		): void;
	};
	onExit(
		subprocess: FakeSubprocess,
		exitCode: number | null,
		signalCode: number | string | null,
		error?: Error,
	): void;
};

const spawnOptions = {
	command: [process.execPath],
	cwd: process.cwd(),
	env: process.env,
};

describe("Bun host admission", () => {
	it("requires the real host to provide native PTY support", () => {
		assert.ok(requireBunRuntime());
	});

	it("rejects a non-Bun runtime with an explicit host requirement", () => {
		assert.throws(
			() => requireBunRuntime(null),
			/requires a Bun host with Bun\.Terminal; the current runtime is not Bun/,
		);
	});

	it("rejects Bun without Terminal support and names its version", () => {
		assert.throws(
			() => requireBunRuntime({ version: "1.3.3", spawn() {} }),
			/requires a Bun host with Bun\.Terminal; Bun 1\.3\.3 does not provide Bun\.spawn with Bun\.Terminal support/,
		);
	});

	it("rejects Bun without spawn support", () => {
		assert.throws(
			() => requireBunRuntime({ version: "test", Terminal() {} }),
			/requires a Bun host with Bun\.Terminal; Bun test does not provide Bun\.spawn/,
		);
	});
});

describe("Bun PTY lifecycle", () => {
	it("replays data and exit when Bun invokes callbacks before spawn returns", () => {
		const terminal: FakeTerminal = { closed: true, write: () => 0, close() {} };
		const subprocess: FakeSubprocess = { pid: 123, terminal, kill() {} };
		const runtime = {
			spawn(_command: string[], options: FakeBunSpawnOptions) {
				options.terminal.data(terminal, new TextEncoder().encode("EARLY_DATA"));
				options.terminal.exit(terminal, 0, null);
				options.onExit(subprocess, 0, null);
				return subprocess;
			},
		};
		const child = spawnBunPty(runtime, spawnOptions);
		let output = "";
		child.onData((chunk) => { output += new TextDecoder().decode(chunk); });
		let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
		child.onExit((...args) => { exit = args; });
		assert.equal(output, "EARLY_DATA");
		assert.deepEqual(exit, [0, null, undefined]);
		assert.equal(child.processExited, true);
	});

	it("waits for terminal closure after an early Bun process exit", () => {
		const terminal: FakeTerminal = {
			closed: false,
			write: () => 0,
			close() { this.closed = true; },
		};
		const subprocess: FakeSubprocess = { pid: 123, terminal, kill() {} };
		let emitData: ((value: string) => void) | undefined;
		let closeTerminal: (() => void) | undefined;
		const runtime = {
			spawn(_command: string[], options: FakeBunSpawnOptions) {
				emitData = (value) => options.terminal.data(terminal, new TextEncoder().encode(value));
				closeTerminal = () => {
					terminal.closed = true;
					options.terminal.exit(terminal, 0, null);
				};
				options.onExit(subprocess, 0, null);
				return subprocess;
			},
		};
		const child = spawnBunPty(runtime, spawnOptions);
		let output = "";
		const unsubscribe = child.onData((chunk) => { output += new TextDecoder().decode(chunk); });
		let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
		child.onExit((...args) => { exit = args; });
		assert.equal(exit, undefined);
		assert.ok(emitData);
		emitData("FIRST");
		assert.equal(output, "FIRST");
		unsubscribe();
		emitData("UNSUBSCRIBED");
		let resubscribedOutput = "";
		child.onData((chunk) => { resubscribedOutput += new TextDecoder().decode(chunk); });
		assert.equal(resubscribedOutput, "");
		emitData("LATE_DATA");
		assert.equal(resubscribedOutput, "LATE_DATA");
		assert.ok(closeTerminal);
		closeTerminal();
		assert.deepEqual(exit, [0, null, undefined]);
	});
});
