/**
 * Guards for the PTY provider package:
 *
 * 1. When EXPECT_PTY=1 (set in CI for all matrix platforms), assert the
 *    @homebridge/node-pty-prebuilt-multiarch module actually loads. Without
 *    this, a prebuild/load failure silently skips the whole PTY e2e suite
 *    and CI stays green while PTY spawning is broken.
 *
 * 2. disposeWindowsConpty pokes undocumented node-pty internals
 *    (_agent._conoutSocketWorker etc.); a mock-agent test locks the calls
 *    it must make and its tolerance for missing fields.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { disposeWindowsConpty, getPtyLoadError, isPtyAvailable, spawnChild } from "../src/pty.ts";

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

describe("PTY module loading", () => {
	it("loads when EXPECT_PTY=1", { skip: process.env.EXPECT_PTY !== "1" }, () => {
		assert.equal(isPtyAvailable(), true, `PTY module failed to load: ${getPtyLoadError()}`);
	});

	it("reports a load error message when unavailable", () => {
		if (isPtyAvailable()) {
			assert.equal(getPtyLoadError(), undefined);
		} else {
			assert.match(getPtyLoadError() ?? "", /node-pty-prebuilt-multiarch/);
		}
	});

	it("never falls back to node-pty when Bun lacks Terminal support", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "Bun");
		Object.defineProperty(globalThis, "Bun", {
			configurable: true,
			value: { version: "1.3.3", spawn() {} },
		});
		try {
			assert.equal(isPtyAvailable(), false);
			assert.match(getPtyLoadError() ?? "", /Bun 1\.3\.3.*Bun\.Terminal/);
			assert.throws(
				() =>
					spawnChild({
						command: [process.execPath],
						cwd: process.cwd(),
						env: process.env,
					}),
				/exec_command needs a PTY.*Upgrade Bun.*Bun\.Terminal/,
			);
		} finally {
			if (original) Object.defineProperty(globalThis, "Bun", original);
			else Reflect.deleteProperty(globalThis, "Bun");
		}
	});

	it("replays data and exit when Bun invokes callbacks before spawn returns", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "Bun");
		const terminal = {
			closed: true,
			write: () => 0,
			close() {},
		};
		const subprocess = {
			pid: 123,
			terminal,
			kill() {},
		};
		Object.defineProperty(globalThis, "Bun", {
			configurable: true,
			value: {
				version: "test",
				Terminal: function Terminal() {},
				spawn(_command: string[], options: FakeBunSpawnOptions) {
					options.terminal.data(terminal, new TextEncoder().encode("EARLY_DATA"));
					options.terminal.exit(terminal, 0, null);
					options.onExit(subprocess, 0, null);
					return subprocess;
				},
			},
		});
		try {
			const child = spawnChild({
				command: [process.execPath],
				cwd: process.cwd(),
				env: process.env,
			});
			let output = "";
			child.onData((chunk) => {
				output += new TextDecoder().decode(chunk);
			});
			let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
			child.onExit((...args) => {
				exit = args;
			});
			assert.equal(output, "EARLY_DATA");
			assert.deepEqual(exit, [0, null, undefined]);
			assert.equal(child.processExited, true);
		} finally {
			if (original) Object.defineProperty(globalThis, "Bun", original);
			else Reflect.deleteProperty(globalThis, "Bun");
		}
	});

	it("waits for terminal closure after an early Bun process exit", (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const original = Object.getOwnPropertyDescriptor(globalThis, "Bun");
		const terminal = {
			closed: false,
			write: () => 0,
			close() {
				this.closed = true;
			},
		};
		const subprocess = {
			pid: 123,
			terminal,
			kill() {},
		};
		let emitData: ((value: string) => void) | undefined;
		let closeTerminal: (() => void) | undefined;
		Object.defineProperty(globalThis, "Bun", {
			configurable: true,
			value: {
				version: "test",
				Terminal: function Terminal() {},
				spawn(_command: string[], options: FakeBunSpawnOptions) {
					emitData = (value) =>
						options.terminal.data(terminal, new TextEncoder().encode(value));
					closeTerminal = () => {
						terminal.closed = true;
						options.terminal.exit(terminal, 0, null);
					};
					options.onExit(subprocess, 0, null);
					return subprocess;
				},
			},
		});
		try {
			const child = spawnChild({
				command: [process.execPath],
				cwd: process.cwd(),
				env: process.env,
			});
			let output = "";
			const unsubscribe = child.onData((chunk) => {
				output += new TextDecoder().decode(chunk);
			});
			let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
			child.onExit((...args) => {
				exit = args;
			});
			context.mock.timers.tick(300);
			assert.equal(exit, undefined);
			assert.ok(emitData);
			emitData("FIRST");
			assert.equal(output, "FIRST");
			unsubscribe();
			emitData("UNSUBSCRIBED");
			let resubscribedOutput = "";
			child.onData((chunk) => {
				resubscribedOutput += new TextDecoder().decode(chunk);
			});
			assert.equal(resubscribedOutput, "");
			emitData("LATE_DATA");
			assert.equal(resubscribedOutput, "LATE_DATA");
			assert.ok(closeTerminal);
			closeTerminal();
			assert.deepEqual(exit, [0, null, undefined]);
		} finally {
			if (original) Object.defineProperty(globalThis, "Bun", original);
			else Reflect.deleteProperty(globalThis, "Bun");
		}
	});
});

describe("disposeWindowsConpty", () => {
	it("destroys both sockets and disposes the conout worker", () => {
		const calls: string[] = [];
		const child = {
			_agent: {
				_inSocket: { destroy: () => calls.push("in") },
				_outSocket: { destroy: () => calls.push("out") },
				_conoutSocketWorker: { dispose: () => calls.push("worker") },
			},
		};
		disposeWindowsConpty(child);
		assert.deepEqual(calls.sort(), ["in", "out", "worker"]);
	});

	it("tolerates missing agent or fields (undocumented internals may change)", () => {
		disposeWindowsConpty(undefined);
		disposeWindowsConpty({});
		disposeWindowsConpty({ _agent: {} });
		disposeWindowsConpty({ _agent: { _inSocket: {}, _outSocket: null } });
	});

	it("swallows exceptions from the internals", () => {
		disposeWindowsConpty({
			_agent: {
				_inSocket: {
					destroy: () => {
						throw new Error("boom");
					},
				},
			},
		});
	});
});
