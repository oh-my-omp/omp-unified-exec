/**
 * Unit tests for src/shell.ts: shell command construction, PATH lookup, the
 * default-shell choice (pi-shell on Windows, bash on POSIX, explicit choices
 * in between), the cmd refusal and `PI_UNIFIED_EXEC_BASH`.
 *
 * The platform branch is a parameter, so both defaults are asserted on every
 * runner. PATH-lookup and resolution tests build synthetic PATH directories
 * under a temp dir and inject them via the env parameter, so Windows-style
 * .exe probing runs anywhere — it's just a filename suffix.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	buildShellCommand,
	type DefaultShellOptions,
	findOnPath,
	IS_WINDOWS,
	resetDefaultShellCache,
	resolveBinary,
	resolveDefaultShell,
	resolveWindowsShell,
	shellArgv,
	type ShellChoice,
} from "../src/shell.ts";

const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

/** The host's cmd.exe test, as omp's `procmgr.isCmdShell` answers it. */
const isCmdShell = (shell: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(shell);

/** One selection with the stub classifier plus the case's own options. */
function choose(
	env: NodeJS.ProcessEnv | undefined,
	requested?: string,
	options: Partial<DefaultShellOptions> = {},
): ShellChoice {
	return resolveDefaultShell(env, requested, { isCmdShell, ...options });
}

/** Create a synthetic PATH dir containing the given (regular) files. */
const tempRoots: string[] = [];
function makePathDir(name: string, files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), `uexec-shell-${name}-`));
	tempRoots.push(dir);
	for (const f of files) {
		const full = join(dir, f);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "");
	}
	return dir;
}

after(() => {
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
	resetDefaultShellCache();
});

describe("buildShellCommand", () => {
	it("POSIX shells get -c", () => {
		assert.deepEqual(buildShellCommand("bash", "echo hi"), ["bash", "-c", "echo hi"]);
		assert.deepEqual(buildShellCommand("sh", "ls"), ["sh", "-c", "ls"]);
		assert.deepEqual(buildShellCommand("zsh", "ls"), ["zsh", "-c", "ls"]);
	});

	it("absolute bash path still gets -c", () => {
		assert.deepEqual(buildShellCommand("/usr/bin/bash", "echo hi"), ["/usr/bin/bash", "-c", "echo hi"]);
	});

	it("Windows bash.exe path gets -c (extension and case insensitive)", () => {
		assert.deepEqual(buildShellCommand("C:\\Program Files\\Git\\bin\\BASH.EXE", "echo hi"), [
			"C:\\Program Files\\Git\\bin\\BASH.EXE",
			"-c",
			"echo hi",
		]);
	});

	it("powershell and pwsh allow PTY interaction with -NoProfile -NoLogo -Command", () => {
		const flags = ["-NoProfile", "-NoLogo", "-Command", "Get-Date"];
		assert.deepEqual(buildShellCommand("powershell", "Get-Date"), ["powershell", ...flags]);
		assert.deepEqual(buildShellCommand("pwsh", "Get-Date"), ["pwsh", ...flags]);
		assert.deepEqual(buildShellCommand("powershell.exe", "Get-Date"), ["powershell.exe", ...flags]);
	});

	it("multiline commands are passed through unchanged", () => {
		assert.deepEqual(buildShellCommand("bash", "echo one\necho two"), ["bash", "-c", "echo one\necho two"]);
	});
});

describe("shellArgv", () => {
	it("runs pi-shell through omp's own bash subcommand", () => {
		assert.deepEqual(shellArgv({ kind: "pi-shell", shell: "C:\\omp\\omp.exe" }, "echo hi"), [
			"C:\\omp\\omp.exe",
			"bash",
			"-c",
			"echo hi",
		]);
		assert.deepEqual(shellArgv({ kind: "pi-shell", shell: "/opt/omp/bin/omp" }, "echo hi"), [
			"/opt/omp/bin/omp",
			"bash",
			"-c",
			"echo hi",
		]);
	});

	it("builds an explicit shell's own argv", () => {
		assert.deepEqual(shellArgv({ kind: "shell", shell: "/bin/bash" }, "echo hi"), ["/bin/bash", "-c", "echo hi"]);
		assert.deepEqual(shellArgv({ kind: "shell", shell: "pwsh" }, "Get-Date"), [
			"pwsh",
			"-NoProfile",
			"-NoLogo",
			"-Command",
			"Get-Date",
		]);
	});
});

describe("findOnPath", () => {
	it("finds node (present in every test environment)", () => {
		assert.ok(findOnPath("node"), "expected node to be found on PATH");
	});

	it("returns undefined for a nonexistent binary or empty PATH", () => {
		assert.equal(findOnPath("definitely-not-a-real-binary-12345"), undefined);
		assert.equal(findOnPath("node", { PATH: "" }), undefined);
	});

	it("probes Windows extensions in order (.exe before .cmd before bare)", () => {
		const dir = makePathDir("exts", ["tool.exe", "tool.cmd", "tool"]);
		const found = findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS });
		assert.equal(found, join(dir, "tool.exe"));
	});

	it("falls through extensions to the bare name", () => {
		const dir = makePathDir("bare", ["tool"]);
		assert.equal(findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS }), join(dir, "tool"));
	});

	it("earlier PATH entries win", () => {
		const first = makePathDir("first", ["tool.exe"]);
		const second = makePathDir("second", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: first + delimiter + second }, { exts: WIN_EXTS });
		assert.equal(found, join(first, "tool.exe"));
	});

	it("skips directories that match the name (only regular files count)", () => {
		const trap = mkdtempSync(join(tmpdir(), "uexec-shell-dirtrap-"));
		tempRoots.push(trap);
		mkdirSync(join(trap, "tool.exe")); // a DIRECTORY named tool.exe
		const real = makePathDir("real", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: trap + delimiter + real }, { exts: WIN_EXTS });
		assert.equal(found, join(real, "tool.exe"));
	});

	it("honors the exclude pattern", () => {
		const excluded = makePathDir("excl", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: excluded }, { exts: WIN_EXTS, exclude: /uexec-shell-excl/ });
		assert.equal(found, undefined);
	});
});

describe("resolveWindowsShell", () => {
	it("resolves bare names to absolute .exe paths", () => {
		const dir = makePathDir("ws", ["myshell.exe"]);
		assert.equal(resolveWindowsShell("myshell", { PATH: dir }), join(dir, "myshell.exe"));
	});

	it("fails closed on unresolvable bare names (no cwd-first spawn)", () => {
		assert.throws(() => resolveWindowsShell("nonexistent-shell-4711", { PATH: "" }), /not found on PATH/);
	});

	it("does not resolve to .cmd/.bat (Node cannot spawn them directly)", () => {
		const dir = makePathDir("wscmd", ["wrapper.cmd", "wrapper.bat"]);
		assert.throws(() => resolveWindowsShell("wrapper", { PATH: dir }), /not found on PATH/);
	});

	it("passes explicit paths through", () => {
		assert.equal(resolveWindowsShell("C:\\tools\\x.exe", { PATH: "" }), "C:\\tools\\x.exe");
	});

	it("PI_UNIFIED_EXEC_BASH names the bash that a bash name resolves to", () => {
		const override = makePathDir("envbash", ["custom-bash.exe"]);
		const pathDir = makePathDir("pathbash", ["bash.exe"]);
		const env = { PATH: pathDir, PI_UNIFIED_EXEC_BASH: join(override, "custom-bash.exe") };
		assert.equal(resolveWindowsShell("bash", env), join(override, "custom-bash.exe"));
		assert.equal(resolveWindowsShell("bash.exe", env), join(override, "custom-bash.exe"));
	});

	it("ignores PI_UNIFIED_EXEC_BASH for other shells and when it names no file", () => {
		const override = makePathDir("envbash2", ["custom-bash.exe"]);
		const pathDir = makePathDir("pathbash2", ["powershell.exe", "bash.exe"]);
		assert.equal(
			resolveWindowsShell("powershell", { PATH: pathDir, PI_UNIFIED_EXEC_BASH: join(override, "custom-bash.exe") }),
			join(pathDir, "powershell.exe"),
		);
		assert.equal(
			resolveWindowsShell("bash", { PATH: pathDir, PI_UNIFIED_EXEC_BASH: join(override, "nope.exe") }),
			join(pathDir, "bash.exe"),
		);
	});

	it("keeps a bash name off System32's WSL stub", () => {
		const stub = makePathDir("sys", ["System32/bash.exe"]);
		const git = makePathDir("gitbin", ["bash.exe"]);
		assert.equal(
			resolveWindowsShell("bash", { PATH: join(stub, "System32") + delimiter + git }),
			join(git, "bash.exe"),
		);
		assert.throws(() => resolveWindowsShell("bash", { PATH: join(stub, "System32") }), /pi-shell/);
	});

	it("unresolvable bash points at pi-shell and PI_UNIFIED_EXEC_BASH", () => {
		assert.throws(() => resolveWindowsShell("bash", { PATH: "" }), /PI_UNIFIED_EXEC_BASH/);
		assert.throws(() => resolveWindowsShell("bash", { PATH: "" }), /pi-shell/);
	});
});

describe("resolveDefaultShell", () => {
	it("Windows: the platform default is omp's pi-shell", () => {
		for (const requested of [undefined, "", " \t\n"]) {
			assert.deepEqual(choose({ PATH: "" }, requested, { isWindows: true, omp: "C:\\omp\\omp.exe" }), {
				kind: "pi-shell",
				shell: "C:\\omp\\omp.exe",
			});
		}
		// Nothing on PATH changes it: there is no probe left to find a bash.
		const bashDir = makePathDir("defaultbash", ["bash.exe"]);
		assert.deepEqual(choose({ PATH: bashDir }, undefined, { isWindows: true, omp: "C:\\omp\\omp.exe" }), {
			kind: "pi-shell",
			shell: "C:\\omp\\omp.exe",
		});
	});

	it("Windows: the pi-shell executable defaults to the omp process's own binary", () => {
		// Inside omp, process.execPath is the omp binary; a bun driver passes Bun.which("omp").
		assert.deepEqual(choose({}, undefined, { isWindows: true }), { kind: "pi-shell", shell: process.execPath });
	});

	it("POSIX: the platform default stays bash", () => {
		for (const requested of [undefined, "", " \t\n"]) {
			assert.deepEqual(choose({ PATH: "" }, requested, { isWindows: false }), { kind: "shell", shell: "bash" });
		}
	});

	it("prefers the caller's trimmed choice over SHELL and the default", () => {
		assert.deepEqual(choose({ SHELL: "/bin/dash" }, "  /bin/zsh \n", { isWindows: true }), {
			kind: "shell",
			shell: "/bin/zsh",
		});
		assert.deepEqual(choose({ SHELL: "/bin/dash" }, "nonexistent-host-shell-4711", { isWindows: true }), {
			kind: "shell",
			shell: "nonexistent-host-shell-4711",
		});
	});

	it("uses trimmed SHELL when the call and the host setting name nothing", () => {
		for (const requested of [undefined, "", " \t\n"]) {
			assert.deepEqual(choose({ SHELL: " \t /bin/dash \n" }, requested, { isWindows: true }), {
				kind: "shell",
				shell: "/bin/dash",
			});
		}
	});

	it("refuses an explicit cmd and names the setting that supplied it", () => {
		assert.deepEqual(
			choose({}, "C:\\Windows\\System32\\cmd.exe", { isWindows: true, requestedSource: "call" }),
			{ kind: "refused", shell: "C:\\Windows\\System32\\cmd.exe", reason: "cmd", source: "call" },
		);
		assert.deepEqual(choose({}, "cmd", { isWindows: true, requestedSource: "shellPath" }), {
			kind: "refused",
			shell: "cmd",
			reason: "cmd",
			source: "shellPath",
		});
		// Neither the call nor the host setting names a shell: SHELL supplied it.
		assert.deepEqual(choose({ SHELL: " cmd.exe " }, undefined, { isWindows: true }), {
			kind: "refused",
			shell: "cmd.exe",
			reason: "cmd",
			source: "SHELL",
		});
	});

	it("keeps a non-cmd shell that merely contains the name", () => {
		assert.deepEqual(choose({}, "C:\\tools\\cmdline.exe", { isWindows: true }), {
			kind: "shell",
			shell: "C:\\tools\\cmdline.exe",
		});
	});

	it("reads each supplied environment without caching SHELL", () => {
		const env: NodeJS.ProcessEnv = { SHELL: "first-env-shell" };
		assert.deepEqual(choose(env), { kind: "shell", shell: "first-env-shell" });
		env.SHELL = "second-env-shell";
		assert.deepEqual(choose(env), { kind: "shell", shell: "second-env-shell" });
		assert.deepEqual(choose({ SHELL: "third-env-shell" }), { kind: "shell", shell: "third-env-shell" });
	});

	it("reads live process settings and does not inherit them into an explicit environment", () => {
		const previous = process.env.SHELL;
		try {
			process.env.SHELL = "first-process-shell";
			assert.deepEqual(choose(undefined), { kind: "shell", shell: "first-process-shell" });
			process.env.SHELL = " \t second-process-shell \n";
			assert.deepEqual(choose(undefined), { kind: "shell", shell: "second-process-shell" });
			assert.deepEqual(choose(undefined, "first-host-shell"), { kind: "shell", shell: "first-host-shell" });
			assert.deepEqual(choose(undefined, "second-host-shell"), { kind: "shell", shell: "second-host-shell" });
			assert.deepEqual(choose(undefined, " \t"), { kind: "shell", shell: "second-process-shell" });
			// A supplied environment never sees the process's SHELL.
			assert.deepEqual(choose({ PATH: "" }, undefined, { isWindows: false }), { kind: "shell", shell: "bash" });
			assert.deepEqual(choose({ PATH: "" }, undefined, { isWindows: true, omp: "omp" }), {
				kind: "pi-shell",
				shell: "omp",
			});
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
		}
	});
});

describe("resolveBinary", () => {
	it("passes through names with a directory component", () => {
		assert.equal(resolveBinary("/usr/bin/bash"), "/usr/bin/bash");
		assert.equal(resolveBinary("C:\\tools\\thing.exe"), "C:\\tools\\thing.exe");
	});

	it("resolves bare names via the provided env PATH", () => {
		const dir = makePathDir("rb", IS_WINDOWS ? ["mytool.exe"] : ["mytool"]);
		assert.equal(resolveBinary("mytool", { PATH: dir }), join(dir, IS_WINDOWS ? "mytool.exe" : "mytool"));
	});

	it("returns the bare name when unresolvable", () => {
		assert.equal(resolveBinary("definitely-not-real-98765", { PATH: "" }), "definitely-not-real-98765");
	});

	it("caches no-env resolutions across PATH changes (production path)", () => {
		resetDefaultShellCache();
		const dir = makePathDir("rbcache", IS_WINDOWS ? ["cachetool.exe"] : ["cachetool"]);
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = dir;
			const first = resolveBinary("cachetool");
			assert.equal(first, join(dir, IS_WINDOWS ? "cachetool.exe" : "cachetool"));
			process.env.PATH = ""; // a fresh lookup would now fail...
			assert.equal(resolveBinary("cachetool"), first); // ...but the cache holds
		} finally {
			process.env.PATH = savedPath;
			resetDefaultShellCache();
		}
	});

	it("resolves relative PATH entries to absolute paths", () => {
		// A relative PATH entry must not produce a cwd-dependent result.
		const found = findOnPath("node", { PATH: process.env.PATH ?? "" });
		assert.ok(found);
		const dir = makePathDir("rel", IS_WINDOWS ? ["reltool.exe"] : ["reltool"]);
		const cwd = process.cwd();
		try {
			process.chdir(join(dir, ".."));
			const rel = dir.slice(join(dir, "..").length + 1); // relative dir name
			const hit = findOnPath("reltool", { PATH: rel }, { exts: IS_WINDOWS ? [".exe"] : [""] });
			assert.ok(hit && (hit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(hit)), `not absolute: ${hit}`);
		} finally {
			process.chdir(cwd);
		}
	});
});
