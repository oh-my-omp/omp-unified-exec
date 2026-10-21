import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	removeTernPlugin,
	retireTernPlugin,
	TERN_PLUGIN_ID,
	TernPluginRemovalError,
	type RemovalOutcome,
} from "../fork-features/tern-plugin-removal.ts";

const fixtureBin = mkdtempSync(join(tmpdir(), "tern-plugin-bin-"));
after(() => { rmSync(fixtureBin, { recursive: true, force: true }); });
before(() => {
	const executable = join(fixtureBin, process.platform === "win32" ? "tern.exe" : "tern");
	execFileSync(process.execPath, [
		"build", "--compile", fileURLToPath(new URL("./fixtures/tern-cli.mjs", import.meta.url)),
		"--outfile", executable,
	], { stdio: "inherit" });
});

interface SimulatorOptions {
	readonly failure?: "list" | "remove" | "unlink";
	readonly failureMessage?: string;
	readonly catalogReply?: string;
	/** Tern keeps listing the plugin after a successful remove/unlink. */
	readonly stuck?: boolean;
}

type Installed = "none" | "copy" | "link";

function makeTern(t: TestContext, installed: Installed, options: SimulatorOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "tern-plugin-removal-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); });
	const pluginRoot = join(root, "Tern plugins with spaces");
	const copy = join(pluginRoot, TERN_PLUGIN_ID);
	const link = join(pluginRoot, `${TERN_PLUGIN_ID}.path`);
	const linkTarget = join(root, "developer checkout");
	const logPath = join(root, "argv.jsonl");
	const optionsPath = join(root, "options.json");
	const emptyPath = join(root, "empty-bin");
	mkdirSync(pluginRoot);
	mkdirSync(emptyPath);
	mkdirSync(linkTarget);
	writeFileSync(join(linkTarget, "terminals.css"), "/* checkout */");
	if (installed === "copy") {
		mkdirSync(copy);
		writeFileSync(join(copy, "terminals.css"), "/* copy */");
	}
	if (installed === "link") writeFileSync(link, `${linkTarget}\n`);
	writeFileSync(logPath, "");
	writeFileSync(optionsPath, JSON.stringify(options));
	const env: NodeJS.ProcessEnv = {
		// No ambient Tern: the fixture is the only executable on PATH.
		PATH: fixtureBin,
		TERN_TEST_OPTIONS: optionsPath,
		TERN_TEST_ROOT: pluginRoot,
		TERN_TEST_LOG: logPath,
	};
	return {
		env, copy, link, linkTarget, emptyPath,
		get calls(): string[][] {
			return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as string[]);
		},
	};
}

function failed(outcome: RemovalOutcome) {
	assert.equal(outcome.kind, "failed");
	assert.ok(outcome.kind === "failed");
	return outcome.failure;
}

describe("removing the Tern plugin earlier versions installed", () => {
	it("removes an installed copy through Tern and confirms Tern no longer lists it", async (t) => {
		const h = makeTern(t, "copy");
		assert.deepEqual(await removeTernPlugin(h.env), { kind: "removed", via: "remove" });
		assert.equal(existsSync(h.copy), false);
		assert.deepEqual(h.calls, [
			["plugin", "list", "--json"],
			["plugin", "remove", TERN_PLUGIN_ID, "--json"],
			["plugin", "list", "--json"],
		]);
	});

	it("unlinks a developer link only after Tern answers that the plugin is linked, leaving the linked checkout", async (t) => {
		const h = makeTern(t, "link");
		assert.deepEqual(await removeTernPlugin(h.env), { kind: "removed", via: "unlink" });
		assert.equal(existsSync(h.link), false);
		assert.equal(readFileSync(join(h.linkTarget, "terminals.css"), "utf8"), "/* checkout */");
		assert.deepEqual(h.calls.map((args) => args[1]), ["list", "remove", "unlink", "list"]);
	});

	it("changes nothing when Tern lists no such plugin, and is idempotent after a removal", async (t) => {
		const h = makeTern(t, "copy");
		await retireTernPlugin(h.env);
		assert.deepEqual(await removeTernPlugin(h.env), { kind: "absent" });
		assert.deepEqual(h.calls.slice(3), [["plugin", "list", "--json"]]);
	});

	it("does nothing without a tern executable", async (t) => {
		const h = makeTern(t, "copy");
		const env = { ...h.env, PATH: h.emptyPath };
		assert.deepEqual(await removeTernPlugin(env), { kind: "unavailable" });
		await retireTernPlugin(env);
		assert.deepEqual(h.calls, []);
		assert.equal(existsSync(h.copy), true);
	});

	it("rejects loading with Tern's diagnostics when remove fails for another reason, without unlinking", async (t) => {
		const h = makeTern(t, "copy", { failure: "remove", failureMessage: "tern plugin: permission denied" });
		const failure = failed(await removeTernPlugin(h.env));
		assert.ok(failure.kind === "command");
		assert.equal(failure.stage, "remove");
		assert.equal(failure.details.exitCode, 23);
		assert.equal(h.calls.some((args) => args[1] === "unlink"), false);
		assert.equal(existsSync(h.copy), true);
		await assert.rejects(retireTernPlugin(h.env), (error: unknown) =>
			error instanceof TernPluginRemovalError && /failed at remove/.test(error.message) && /permission denied/.test(error.message));
	});

	it("reports a failed unlink at its stage", async (t) => {
		const h = makeTern(t, "link", { failure: "unlink" });
		const failure = failed(await removeTernPlugin(h.env));
		assert.ok(failure.kind === "command");
		assert.equal(failure.stage, "unlink");
		assert.equal(existsSync(h.link), true);
	});

	it("fails inspection on an unreadable catalog and never removes", async (t) => {
		for (const options of [{ failure: "list" }, { catalogReply: "not JSON" }, { catalogReply: "{\"plugins\":7}" }] as const) {
			const h = makeTern(t, "copy", options);
			const failure = failed(await removeTernPlugin(h.env));
			assert.equal("stage" in failure && failure.stage, "inspect");
			assert.equal(h.calls.some((args) => args[1] === "remove"), false);
			assert.equal(existsSync(h.copy), true);
		}
	});

	it("fails verification when Tern still lists the plugin after removing it", async (t) => {
		const h = makeTern(t, "copy", { stuck: true });
		const failure = failed(await removeTernPlugin(h.env));
		assert.equal(failure.kind, "verification");
		await assert.rejects(retireTernPlugin(h.env), TernPluginRemovalError);
	});
});
