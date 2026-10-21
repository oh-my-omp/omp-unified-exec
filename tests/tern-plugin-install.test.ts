import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
	rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ensureTernPlugin,
	initializeTernPlugin,
	parsePluginList,
	parsePluginVersion,
	planPluginAction,
	readPluginFiles,
	TERN_PLUGIN_ID,
	TernPluginInitializationError,
	type CopyState,
	type InstallOutcome,
	type ListedPlugin,
	type PluginFiles,
} from "../fork-features/tern-plugin-install.ts";

const fixtureBin = mkdtempSync(join(tmpdir(), "tern-plugin-bin-"));
after(() => { rmSync(fixtureBin, { recursive: true, force: true }); });
before(() => {
	const executable = join(fixtureBin, process.platform === "win32" ? "tern.exe" : "tern");
	execFileSync(process.execPath, [
		"build", "--compile", fileURLToPath(new URL("./fixtures/tern-cli.mjs", import.meta.url)),
		"--outfile", executable,
	], { stdio: "inherit" });
});

function listedPlugin(files: PluginFiles, overrides: Partial<ListedPlugin> = {}): ListedPlugin {
	return { id: TERN_PLUGIN_ID, version: files.version, css: files.css, status: "ready", ...overrides };
}

function writeBundle(dir: string, files: PluginFiles): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "plugin.toml"), files.manifest);
	writeFileSync(join(dir, "terminals.css"), files.css);
	writeFileSync(join(dir, "window.luau"), files.windowScript);
}

type CopyFault = "no-copy" | "css" | "manifest" | "windowScript" | "extra-file" | "missing-file" | "symlink";
type ReplyFault = "malformed" | "missing-fields" | "wrong-id" | "wrong-version" | "wrong-dir" | "relative-dir";
interface SimulatorOptions {
	readonly initialCatalog?: readonly ListedPlugin[];
	readonly installedCatalog?: readonly ListedPlugin[];
	readonly conflictCatalog?: readonly ListedPlugin[];
	readonly failure?: "dir" | "list" | "install" | "unlink";
	readonly installError?: string;
	readonly ownerConflict?: string;
	readonly copyFault?: CopyFault;
	readonly replyFault?: ReplyFault;
	readonly directoryReply?: string;
	readonly catalogReply?: string;
}

interface Harness {
	readonly env: NodeJS.ProcessEnv;
	readonly root: string;
	readonly files: PluginFiles;
	readonly sourceDir: string;
	readonly legacyDir: string;
	readonly destination: string;
	readonly registration: string;
	readonly emptyPath: string;
	readonly calls: string[][];
}

/** Per-case state for the shared, independently executable CLI simulator. */
function makeTern(t: TestContext, options: SimulatorOptions = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "tern-plugin-install-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); });
	const pluginRoot = join(root, "Tern plugins with spaces");
	const sourceDir = join(root, "package source ; $not-expanded");
	const legacyDir = join(root, "legacy checkout with spaces");
	const destination = join(pluginRoot, TERN_PLUGIN_ID);
	const registration = join(pluginRoot, `${TERN_PLUGIN_ID}.path`);
	const logPath = join(root, "argv.jsonl");
	const emptyPath = join(root, "empty-bin");
	const optionsPath = join(root, "options.json");
	const installedPath = join(root, "installed");
	const conflictPath = join(root, "conflict");
	const files = readPluginFiles();
	mkdirSync(pluginRoot);
	mkdirSync(emptyPath);
	writeBundle(sourceDir, files);
	writeBundle(legacyDir, files);
	writeFileSync(logPath, "");
	writeFileSync(optionsPath, JSON.stringify(options));
	const env: NodeJS.ProcessEnv = {
		// No ambient Tern or pane environment: the fixture is the only executable on PATH.
		PATH: fixtureBin,
		TERN_TEST_OPTIONS: optionsPath,
		TERN_TEST_ROOT: pluginRoot,
		TERN_TEST_LOG: logPath,
		TERN_TEST_INSTALLED: installedPath,
		TERN_TEST_CONFLICT: conflictPath,
	};
	return {
		env, root, files, sourceDir, legacyDir, destination, registration, emptyPath,
		get calls(): string[][] {
			return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as string[]);
		},
	};
}

function assertExactCopy(h: Harness): void {
	assert.equal(existsSync(h.registration), false, "developer registration must not remain");
	assert.equal(lstatSync(h.destination).isSymbolicLink(), false);
	assert.equal(lstatSync(h.destination).isDirectory(), true);
	assert.deepEqual(readdirSync(h.destination).sort(), ["plugin.toml", "terminals.css", "window.luau"]);
	for (const name of ["plugin.toml", "terminals.css", "window.luau"]) {
		assert.equal(lstatSync(join(h.destination, name)).isFile(), true);
		assert.equal(readFileSync(join(h.destination, name), "utf8"), readFileSync(join(h.sourceDir, name), "utf8"));
	}
}

function assertNoDestructiveCall(h: Harness): void {
	assert.equal(h.calls.some((args) => args[1] === "unlink" || args[1] === "remove" || args[1] === "link"), false);
}

function assertFailed(outcome: InstallOutcome, kind: "command" | "inspection" | "verification") {
	assert.equal(outcome.kind, "failed");
	assert.ok(outcome.kind === "failed");
	assert.equal(outcome.failure.kind, kind);
	return outcome.failure;
}

function bundleSnapshot(dir: string) {
	return ["", ...readdirSync(dir).sort()].map((name) => {
		const file = join(dir, name);
		const stat = lstatSync(file);
		return { name, ino: stat.ino, mtimeMs: stat.mtimeMs, content: stat.isFile() ? readFileSync(file, "utf8") : null };
	});
}

describe("Tern plugin file and CLI parsers", () => {
	it("reads the quoted version from a multiline manifest", () => {
		assert.equal(parsePluginVersion('schema = 1\nid = "plugin"\nversion = "test-version"\n'), "test-version");
		assert.equal(parsePluginVersion('  version  =  "release candidate"  \n'), "release candidate");
	});

	it("rejects manifests without a quoted version assignment", () => {
		for (const toml of ["", 'name = "plugin"', "version = 7", "version = 'test-version'"]) {
			assert.throws(() => parsePluginVersion(toml), Error);
		}
	});

	it("parses catalog entries and accepts an empty plugins array", () => {
		const plugin = listedPlugin(readPluginFiles());
		assert.deepEqual(parsePluginList(JSON.stringify({ plugins: [plugin] })), [plugin]);
		assert.deepEqual(parsePluginList('{"plugins":[]}'), []);
	});

	it("rejects malformed JSON and roots without a plugins array", () => {
		assert.throws(() => parsePluginList("not JSON"), SyntaxError);
		for (const value of [null, 7, "plugins", [], {}, { plugins: null }, { plugins: {} }, { plugins: "[]" }]) {
			assert.throws(() => parsePluginList(JSON.stringify(value)), Error);
		}
	});

	it("ignores unusable ids and defaults nonstring optional catalog fields", () => {
		assert.deepEqual(parsePluginList(JSON.stringify({ plugins: [
			null, 7, "plugin", {}, { id: 42 }, { id: "" },
			{ id: TERN_PLUGIN_ID, version: 7, css: false, status: null }, { id: "another-plugin" },
		] })), [
			{ id: TERN_PLUGIN_ID, version: "", css: "", status: "" },
			{ id: "another-plugin", version: "", css: "", status: "" },
		]);
	});


	it("rejects a source bundle with a different plugin identity or missing required file", (t) => {
		const h = makeTern(t);
		writeFileSync(join(h.sourceDir, "plugin.toml"), h.files.manifest.replace(TERN_PLUGIN_ID, "another-plugin"));
		assert.throws(() => readPluginFiles(h.sourceDir), Error);
		writeFileSync(join(h.sourceDir, "plugin.toml"), h.files.manifest);
		rmSync(join(h.sourceDir, "window.luau"));
		assert.throws(() => readPluginFiles(h.sourceDir), { code: "ENOENT" });
	});
});

describe("Tern plugin copy action planning", () => {
	const files = readPluginFiles();

	it("requires both an exact normal copy and a matching ready catalog", () => {
		assert.deepEqual(planPluginAction([listedPlugin(files)], files, "current"), { kind: "current" });
		for (const copy of ["current", "stale"] satisfies CopyState[]) {
			for (const catalog of [[], [listedPlugin(files, { id: "another-plugin" })]]) {
				assert.deepEqual(planPluginAction(catalog, files, copy), { kind: "install" });
			}
		}
		assert.deepEqual(planPluginAction([listedPlugin(files)], files, "stale"), { kind: "install" });
	});

	it("installs for mismatched catalog version, CSS, or readiness even with a current copy", () => {
		for (const plugin of [
			listedPlugin(files, { version: "old-version" }), listedPlugin(files, { version: "" }),
			listedPlugin(files, { css: ".old-terminal {}" }), listedPlugin(files, { status: "error" }),
			listedPlugin(files, { status: "" }),
		]) {
			assert.deepEqual(planPluginAction([plugin], files, "current"), { kind: "install" });
		}
	});
});

describe("Tern normal-copy installation through an executable CLI", () => {
	it("installs a missing plugin as the exact normal copy, with spaces and shell metacharacters safe", async (t) => {
		const h = makeTern(t);
		assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "installed", version: h.files.version });
		assertExactCopy(h);
		assertNoDestructiveCall(h);
		assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "current" });
		assert.equal(h.calls.filter((args) => args[1] === "install").length, 1);
	});

	it("leaves an identical three-file normal directory and ready catalog untouched", async (t) => {
		const h = makeTern(t);
		writeBundle(h.destination, h.files);
		const old = new Date("2001-01-01T00:00:00Z");
		for (const name of ["plugin.toml", "terminals.css", "window.luau"]) utimesSync(join(h.destination, name), old, old);
		utimesSync(h.destination, old, old);
		const before = bundleSnapshot(h.destination);
		assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "current" });
		assertExactCopy(h);
		assert.deepEqual(bundleSnapshot(h.destination), before);
		assert.equal(h.calls.some((args) => args[1] === "install"), false);
		assertNoDestructiveCall(h);
	});

	for (const stale of ["css", "windowScript", "manifest", "extra-file", "missing-file", "directory-entry", "file-symlink", "directory-symlink"] as const) {
		it(`replaces stale same-version ${stale} with exactly the shipped inventory`, async (t) => {
			const h = makeTern(t);
			writeBundle(h.destination, h.files);
			switch (stale) {
				case "css": writeFileSync(join(h.destination, "terminals.css"), `${h.files.css}\n/* stale */`); break;
				case "windowScript": writeFileSync(join(h.destination, "window.luau"), `${h.files.windowScript}\n-- stale`); break;
				case "manifest": writeFileSync(join(h.destination, "plugin.toml"), `${h.files.manifest}\n# stale`); break;
				case "extra-file": writeFileSync(join(h.destination, "obsolete.txt"), "obsolete"); break;
				case "missing-file": rmSync(join(h.destination, "window.luau")); break;
				case "directory-entry": rmSync(join(h.destination, "window.luau")); mkdirSync(join(h.destination, "window.luau")); break;
				case "file-symlink": rmSync(join(h.destination, "window.luau")); symlinkSync(join(h.sourceDir, "window.luau"), join(h.destination, "window.luau")); break;
				case "directory-symlink": rmSync(h.destination, { recursive: true }); symlinkSync(h.sourceDir, h.destination); break;
			}
			assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "installed", version: h.files.version });
			assertExactCopy(h);
			assertNoDestructiveCall(h);
		});
	}

	for (const stale of ["status", "version", "css", "missing"] as const) {
		it(`reinstalls an exact copy whose catalog has stale ${stale}`, async (t) => {
			const files = readPluginFiles();
			const initialCatalog = stale === "missing" ? [] : [listedPlugin(files, stale === "status" ? { status: "error" }
				: stale === "version" ? { version: "old-version" } : { css: ".old {}" })];
			const h = makeTern(t, { initialCatalog });
			writeBundle(h.destination, h.files);
			assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "installed", version: h.files.version });
			assertExactCopy(h);
			assert.ok(h.calls.some((args) => args[1] === "install"));
			assertNoDestructiveCall(h);
		});
	}

	it("migrates the canonical legacy .path even when its loaded CSS and version are identical", async (t) => {
		const h = makeTern(t);
		writeFileSync(h.registration, `${h.legacyDir}\n`);
		const legacy = bundleSnapshot(h.legacyDir);
		assert.deepEqual(await ensureTernPlugin(h.env, h.sourceDir), { kind: "installed", version: h.files.version });
		assertExactCopy(h);
		assert.deepEqual(bundleSnapshot(h.legacyDir), legacy, "unlink must not delete the legacy source");
		assert.equal(h.calls.some((args) => args[1] === "link" || args[1] === "remove"), false);
	});

	it("returns unavailable without launching any command when Tern is missing", async (t) => {
		const h = makeTern(t);
		const env = { ...h.env, PATH: h.emptyPath };
		assert.deepEqual(await ensureTernPlugin(env, h.sourceDir), { kind: "unavailable" });
		await initializeTernPlugin(env, h.sourceDir);
		assert.deepEqual(h.calls, []);
	});
});

describe("Tern installation failure safety and verification", () => {
	it("does not unlink a legacy registration after an arbitrary install failure", async (t) => {
		const h = makeTern(t, { failure: "install", installError: "permission denied; unrelated plugin is linked" });
		writeFileSync(h.registration, `${h.legacyDir}\n`);
		const legacy = bundleSnapshot(h.legacyDir);
		const failure = assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "command");
		assert.ok(failure.kind === "command");
		assert.equal(failure.stage, "install");
		assert.equal(failure.details.exitCode, 23);
		assert.equal(failure.details.stdout, "owner diagnostic\n");
		assert.match(failure.details.stderr, /permission denied/);
		assert.equal(readFileSync(h.registration, "utf8"), `${h.legacyDir}\n`);
		assert.deepEqual(bundleSnapshot(h.legacyDir), legacy);
		assertNoDestructiveCall(h);
	});

	for (const conflict of ["target-mismatch", "no-registration", "symlink-registration", "directory-registration", "relative-owner-target", "catalog-owner-disappeared"] as const) {
		it(`does not unlink an unsafe ${conflict} conflict`, async (t) => {
			const options: SimulatorOptions = conflict === "target-mismatch" || conflict === "no-registration" || conflict === "directory-registration"
				? { ownerConflict: "/different owner target", initialCatalog: [listedPlugin(readPluginFiles())] }
				: conflict === "relative-owner-target" ? { ownerConflict: "relative target" }
				: conflict === "catalog-owner-disappeared" ? { conflictCatalog: [] } : {};
			const h = makeTern(t, options);
			if (conflict === "symlink-registration") {
				const externalRegistration = join(h.root, "other.path");
				writeFileSync(externalRegistration, `${h.legacyDir}\n`);
				symlinkSync(externalRegistration, h.registration);
			} else if (conflict === "directory-registration") mkdirSync(h.registration);
			else if (conflict !== "no-registration") writeFileSync(h.registration, `${h.legacyDir}\n`);
			const legacy = bundleSnapshot(h.legacyDir);
			const registrationBefore = existsSync(h.registration) ? lstatSync(h.registration) : undefined;
			assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "verification");
			assertNoDestructiveCall(h);
			assert.deepEqual(bundleSnapshot(h.legacyDir), legacy);
			assert.equal(existsSync(h.destination), false);
			assert.equal(existsSync(h.registration), registrationBefore !== undefined);
			if (registrationBefore) {
				assert.equal(lstatSync(h.registration).ino, registrationBefore.ino);
				if (!registrationBefore.isDirectory()) assert.equal(readFileSync(h.registration, "utf8"), `${h.legacyDir}\n`);
			}
		});
	}

	for (const installError of [
		`unrelated: tern plugin: ${TERN_PLUGIN_ID} is linked (/target); use unlink first`,
		`tern plugin: another-plugin is linked (/target); use unlink first`,
		`tern plugin: ${TERN_PLUGIN_ID} is linked (/target); use unlink first; retry advised`,
	]) {
		it(`rejects a noncanonical link diagnostic: ${installError}`, async (t) => {
			const h = makeTern(t, { failure: "install", installError });
			writeFileSync(h.registration, `${h.legacyDir}\n`);
			assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "command");
			assert.equal(readFileSync(h.registration, "utf8"), `${h.legacyDir}\n`);
			assertNoDestructiveCall(h);
		});
	}

	it("preserves the canonical link when Tern refuses unlink", async (t) => {
		const h = makeTern(t, { failure: "unlink" });
		writeFileSync(h.registration, `${h.legacyDir}\n`);
		const failure = assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "command");
		assert.ok(failure.kind === "command");
		assert.equal(failure.stage, "unlink");
		assert.equal(readFileSync(h.registration, "utf8"), `${h.legacyDir}\n`);
		assert.equal(existsSync(h.destination), false);
	});

	for (const replyFault of ["malformed", "missing-fields", "wrong-id", "wrong-version", "wrong-dir", "relative-dir"] satisfies ReplyFault[]) {
		it(`does not accept a ${replyFault} installation reply even after copying`, async (t) => {
			const h = makeTern(t, { replyFault });
			assertFailed(await ensureTernPlugin(h.env, h.sourceDir), replyFault === "malformed" || replyFault === "missing-fields" || replyFault === "relative-dir" ? "inspection" : "verification");
			assertExactCopy(h);
			assertNoDestructiveCall(h);
		});
	}

	for (const copyFault of ["no-copy", "css", "manifest", "windowScript", "extra-file", "missing-file", "symlink"] satisfies CopyFault[]) {
		it(`rejects ${copyFault} despite a success reply and matching ready catalog`, async (t) => {
			const h = makeTern(t, { copyFault, installedCatalog: [listedPlugin(readPluginFiles())] });
			assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "verification");
			if (copyFault === "no-copy") assert.equal(existsSync(h.destination), false);
			else if (copyFault === "symlink") assert.equal(lstatSync(h.destination).isSymbolicLink(), true);
			else if (copyFault === "extra-file") assert.equal(existsSync(join(h.destination, "unexpected.txt")), true);
			else if (copyFault === "missing-file") assert.equal(existsSync(join(h.destination, "window.luau")), false);
			else {
				const name = copyFault === "css" ? "terminals.css" : copyFault === "manifest" ? "plugin.toml" : "window.luau";
				assert.notEqual(readFileSync(join(h.destination, name), "utf8"), readFileSync(join(h.sourceDir, name), "utf8"));
			}
			assertNoDestructiveCall(h);
		});
	}

	for (const installedCatalog of [[], [listedPlugin(readPluginFiles(), { status: "error" })], [listedPlugin(readPluginFiles(), { css: ".stale {}" })]]) {
		it(`rejects an exact copy with an unconfirmed ready catalog: ${JSON.stringify(installedCatalog.map((plugin) => plugin.status))}`, async (t) => {
			const h = makeTern(t, { installedCatalog });
			assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "verification");
			assertExactCopy(h);
		});
	}

	for (const failure of ["dir", "list"] as const) {
		it(`reports typed ${failure} command failure without changing installed files`, async (t) => {
			const h = makeTern(t, { failure });
			writeBundle(h.destination, h.files);
			const before = bundleSnapshot(h.destination);
			const result = assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "command");
			assert.ok(result.kind === "command");
			assert.equal(result.stage, "inspect");
			assert.deepEqual(bundleSnapshot(h.destination), before);
			assert.equal(h.calls.some((args) => args[1] === "install"), false);
			assertNoDestructiveCall(h);
		});
	}

	for (const directoryReply of ["not JSON", '{"dir":"relative"}', '{"dir":7}', '{}']) {
		it(`rejects an invalid owner directory response: ${directoryReply}`, async (t) => {
			const h = makeTern(t, { directoryReply });
			const failure = assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "inspection");
			assert.ok(failure.kind === "inspection");
			assert.equal(failure.stage, "inspect");
			assert.equal(existsSync(h.destination), false);
			assertNoDestructiveCall(h);
		});
	}

	it("rejects an invalid catalog response without attempting install", async (t) => {
		const h = makeTern(t, { catalogReply: '{"plugins":null}' });
		assertFailed(await ensureTernPlugin(h.env, h.sourceDir), "inspection");
		assert.equal(h.calls.some((args) => args[1] === "install"), false);
		assertNoDestructiveCall(h);
	});

	it("initialization awaits a real copied installation and returns with exact files", async (t) => {
		const h = makeTern(t);
		await initializeTernPlugin(h.env, h.sourceDir);
		assertExactCopy(h);
	});

	it("initialization throws its structured command failure when Tern exists but install fails", async (t) => {
		const h = makeTern(t, { failure: "install", installError: "copy denied" });
		await assert.rejects(initializeTernPlugin(h.env, h.sourceDir), (error: unknown) => {
			assert.ok(error instanceof TernPluginInitializationError);
			assert.equal(error.name, "TernPluginInitializationError");
			assert.equal(error.failure.kind, "command");
			assert.ok(error.failure.kind === "command");
			assert.equal(error.failure.stage, "install");
			assert.equal(error.failure.details.exitCode, 23);
			assert.ok(error.failure.details.command.includes(h.sourceDir));
			assert.match(error.message, /copy denied/);
			return true;
		});
		assert.equal(existsSync(h.destination), false);
		assertNoDestructiveCall(h);
	});

	it("initialization throws a structured verification failure when the copy was not made", async (t) => {
		const h = makeTern(t, { copyFault: "no-copy", installedCatalog: [listedPlugin(readPluginFiles())] });
		await assert.rejects(initializeTernPlugin(h.env, h.sourceDir), (error: unknown) => {
			assert.ok(error instanceof TernPluginInitializationError);
			assert.equal(error.failure.kind, "verification");
			return true;
		});
		assert.equal(existsSync(h.destination), false);
	});
});
