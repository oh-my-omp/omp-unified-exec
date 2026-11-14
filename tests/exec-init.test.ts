/**
 * `exec.initFile` through the real exec_command and real PTY shells: the init
 * file's exports and aliases reach the command, a failing file stops the
 * shell before it, and an unusable setting refuses the call before anything
 * runs. The plugin settings reader stands in for omp's `getPluginSettings`.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveInitPath, shellScript } from "../fork-features/exec-init.ts";
import type { PluginSettingsReader } from "../fork-features/plugin-settings.ts";
import { activate } from "../src/index.ts";
import { findOnPath, IS_WINDOWS } from "../src/shell.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

/** The result fields these tests read. */
interface ExecDetails {
	exit_code?: number | null;
	session_id?: number;
	output: string;
	command: string;
	failure_message?: string;
}

interface ToolDef {
	execute: (toolCallId: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<{ details: ExecDetails }>;
}

type Handler = (event: object, ctx: object) => unknown;

interface Harness {
	exec(params: { cmd: string; shell?: string; workdir?: string }): Promise<ExecDetails>;
	shutdown(): Promise<void>;
}

const live = new Set<Harness>();
const roots: string[] = [];

/** A tool core whose calls come from a session at `cwd`, reading plugin settings through `settings`. */
function makeHarness(cwd: string, settings: PluginSettingsReader): Harness {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const ctx = { cwd, ui: { notify() {}, setStatus() {}, setWidget() {} }, hasUI: false };
	const pi = {
		registerTool: (def: ToolDef & { name: string }) => { tools[def.name] = def; },
		on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		getFlag: () => false, getActiveTools: () => ["bash"], setActiveTools() {}, sendMessage() {},
	};
	// The fake supplies only the ExtensionAPI surfaces the tool core consumes.
	activate(pi as unknown as Parameters<typeof activate>[0], undefined, undefined, undefined, undefined, {}, undefined, settings, undefined, stubShellHost);
	const harness: Harness = {
		async exec(params) {
			const result = await tools.exec_command!.execute("call", { title: "init test", yield_time_ms: 10_000, ...params }, undefined, undefined, ctx);
			return result.details;
		},
		async shutdown() {
			for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
		},
	};
	live.add(harness);
	return harness;
}

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ue-init-"));
	roots.push(root);
	return root;
}

const settingsOf = (values: Readonly<Record<string, unknown>>): PluginSettingsReader => async () => values;

afterEach(async () => {
	for (const h of live) await h.shutdown();
	live.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const POSIX_SHELLS = (IS_WINDOWS ? ["bash"] : ["bash", "zsh", "sh"]).filter((shell) => findOnPath(shell) !== undefined);

describe("exec.initFile", () => {
	for (const shell of POSIX_SHELLS) {
		it(`brings the file's exports and aliases to commands under ${shell}`, async () => {
			const root = tempRoot();
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "init.sh"), "export UE_PRESET=preset-ok\nalias greet='echo greeted --flag'\n");
			// Relative to the session cwd, not to the command's workdir.
			const h = makeHarness(root, settingsOf({ "exec.initFile": "init.sh" }));
			const cmd = `greet one; printf 'env=%s\\n' "$UE_PRESET"; printf '%s\\n' "it's quoted"`;
			const r = await h.exec({ cmd, shell, workdir: "sub" });
			assert.equal(r.exit_code, 0, JSON.stringify(r));
			assert.match(r.output, /greeted --flag one/);
			assert.match(r.output, /env=preset-ok/);
			assert.match(r.output, /it's quoted/);
			assert.equal(r.command, cmd, "results name the command as given");
		});
	}

	it("leaves commands as they are when the setting is absent or blank", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "init.sh"), "alias greet='echo greeted'\n");
		for (const values of [{}, { "exec.initFile": "  " }]) {
			const h = makeHarness(root, settingsOf(values));
			const r = await h.exec({ cmd: "greet one", shell: "bash" });
			assert.notEqual(r.exit_code, 0, JSON.stringify(r));
			assert.doesNotMatch(r.output, /greeted/);
		}
	});

	it("stops before the command when the file fails", async () => {
		const root = tempRoot();
		const marker = join(root, "ran");
		const cases = [
			{ body: "set -e\nfalse\nexport AFTER=1\n", expected: 1 },
			{ body: "return 3\n", expected: 3 },
		];
		for (const { body, expected } of cases) {
			writeFileSync(join(root, "init.sh"), body);
			const h = makeHarness(root, settingsOf({ "exec.initFile": join(root, "init.sh") }));
			const r = await h.exec({ cmd: "touch ran", shell: "bash" });
			assert.equal(r.exit_code, expected, `${body}: ${JSON.stringify(r)}`);
			assert.equal(existsSync(marker), false, `${body}: the command must not run`);
		}
	});

	it("refuses the call before spawning when the setting cannot be used", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "dir"));
		const failing: Array<[PluginSettingsReader, string]> = [
			[settingsOf({ "exec.initFile": "missing.sh" }), `exec.initFile does not exist: ${join(root, "missing.sh")}`],
			[settingsOf({ "exec.initFile": "dir" }), `exec.initFile is not a regular file: ${join(root, "dir")}`],
			[settingsOf({ "exec.initFile": 42 }), "plugin setting exec.initFile must be a string path"],
			[async () => { throw new Error("lockfile corrupt"); }, "could not read plugin settings for exec.initFile: lockfile corrupt"],
		];
		for (const [settings, message] of failing) {
			const h = makeHarness(root, settings);
			const r = await h.exec({ cmd: "touch ran", shell: "bash" });
			assert.equal(r.failure_message, message, JSON.stringify(r));
			assert.equal(r.session_id, undefined);
			assert.equal(existsSync(join(root, "ran")), false, "nothing may run");
		}
	});

	it("refuses non-POSIX shells while a file is configured", () => {
		const file = { kind: "file", path: "/tmp/init.sh" } as const;
		for (const shell of ["/usr/bin/fish", "pwsh", "powershell.exe"]) {
			assert.equal(shellScript(file, { kind: "shell", shell }, "echo hi").kind, "unusable", shell);
		}
		for (const shell of ["/bin/bash", "/bin/zsh", "/bin/sh", "dash", "C:\\Git\\bin\\bash.exe"]) {
			assert.equal(shellScript(file, { kind: "shell", shell }, "echo hi").kind, "ready", shell);
		}
	});

	it("sources the file and expands aliases in omp's pi-shell too", () => {
		const file = { kind: "file", path: "/tmp/init.sh" } as const;
		const script = shellScript(file, { kind: "pi-shell", shell: "C:\\omp\\omp.exe" }, "greet one");
		assert.equal(script.kind, "ready");
		assert.match(script.kind === "ready" ? script.cmd : "", /shopt -s expand_aliases/);
	});

	it("resolves ~ to the home directory and other relative paths against the session cwd", () => {
		const home = homedir();
		const cwd = tempRoot();
		assert.equal(resolveInitPath("~", cwd, home), home);
		assert.equal(resolveInitPath("~/omp/init.sh", cwd, home), join(home, "omp", "init.sh"));
		assert.equal(resolveInitPath("tools/init.sh", cwd, home), join(cwd, "tools", "init.sh"));
		assert.equal(resolveInitPath("~user/init.sh", cwd, home), join(cwd, "~user", "init.sh"));
	});
});
