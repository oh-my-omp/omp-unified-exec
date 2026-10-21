/**
 * Removes the Tern plugin earlier versions of this extension installed.
 *
 * Up to 0.14.7 the extension installed a CSS-only Tern plugin
 * (`omp-unified-exec`), a normal copy (0.14.7) or a developer link (0.14.6).
 * The HUD now uses omp's own roles and Tern's built-in styles only, and the
 * old stylesheet still selects omp's shared `belowEditor` container, moving
 * other extensions' widgets. The extension created that plugin, so it ends
 * it: omp awaits this during package install validation and ordinary
 * loading, before activation, as it awaited the installer.
 *
 * Tern owns its plugin directory, registration and reload; every change goes
 * through its CLI, and only the plugin id `omp-unified-exec` is touched.
 */
import { execFile } from "node:child_process";

import { sanitizeOutputText } from "../src/output-safety.ts";
import { findOnPath } from "../src/shell.ts";

/** The id the earlier versions' `plugin.toml` declared. */
export const TERN_PLUGIN_ID = "omp-unified-exec";
// Each change reloads Tern's daemon, whose documented wait is up to 60 seconds.
const CLI_TIMEOUT_MS = 75_000;
const MAX_DIAGNOSTIC_CHARS = 4096;
/** Tern's answer to `remove` for a plugin registered with `link`. */
const LINKED = `tern plugin: ${TERN_PLUGIN_ID} is linked; use unlink`;

export type RemovalStage = "inspect" | "remove" | "unlink" | "verify";

interface CommandFailure {
	readonly command: readonly string[];
	readonly exitCode: string | number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly message: string;
}

export type RemovalFailure =
	| { readonly kind: "command"; readonly stage: RemovalStage; readonly details: CommandFailure }
	| { readonly kind: "inspection"; readonly stage: "inspect" | "verify"; readonly message: string }
	| { readonly kind: "verification"; readonly message: string };

export type RemovalOutcome =
	/** Tern is not installed; nothing of ours can be registered. */
	| { readonly kind: "unavailable" }
	/** Tern lists no `omp-unified-exec` plugin. */
	| { readonly kind: "absent" }
	/** Removed through Tern's `remove` (a copy) or `unlink` (a link). */
	| { readonly kind: "removed"; readonly via: "remove" | "unlink" }
	| { readonly kind: "failed"; readonly failure: RemovalFailure };

/** Pure: the plugin ids of a `tern plugin list --json` answer. */
export function parsePluginIds(json: string): string[] {
	const value: unknown = JSON.parse(json);
	if (typeof value !== "object" || value === null || !("plugins" in value) || !Array.isArray(value.plugins)) {
		throw new Error("tern plugin list --json: no plugins array");
	}
	return value.plugins.flatMap((entry: unknown): string[] =>
		typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? [entry.id] : []);
}

type CliResult =
	| { readonly kind: "success"; readonly stdout: string }
	| { readonly kind: "failure"; readonly details: CommandFailure };

/** Argument-vector spawning, awaited by the factory; never a shell command. */
function ternPlugin(tern: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	execFile(tern, ["plugin", ...args], { env, timeout: CLI_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
		if (!error) {
			resolve({ kind: "success", stdout });
			return;
		}
		resolve({
			kind: "failure",
			details: {
				command: [tern, "plugin", ...args],
				exitCode: error.code ?? null,
				signal: error.signal ?? null,
				stdout,
				stderr,
				message: error.message,
			},
		});
	});
	return promise;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listed(tern: string, env: NodeJS.ProcessEnv, stage: "inspect" | "verify"): Promise<boolean | RemovalOutcome> {
	const catalog = await ternPlugin(tern, ["list", "--json"], env);
	if (catalog.kind === "failure") return { kind: "failed", failure: { kind: "command", stage, details: catalog.details } };
	try {
		return parsePluginIds(catalog.stdout).includes(TERN_PLUGIN_ID);
	} catch (error) {
		return { kind: "failed", failure: { kind: "inspection", stage, message: errorMessage(error) } };
	}
}

/**
 * Ask Tern to remove `omp-unified-exec` when it lists one: `remove` for a
 * copy, `unlink` only when Tern answers that it is linked. Tern's catalog
 * must then no longer list it.
 */
export async function removeTernPlugin(env: NodeJS.ProcessEnv): Promise<RemovalOutcome> {
	const tern = findOnPath("tern", env);
	if (!tern) return { kind: "unavailable" };
	const before = await listed(tern, env, "inspect");
	if (typeof before !== "boolean") return before;
	if (!before) return { kind: "absent" };

	let via: "remove" | "unlink" = "remove";
	const removed = await ternPlugin(tern, ["remove", TERN_PLUGIN_ID, "--json"], env);
	if (removed.kind === "failure") {
		if (removed.details.stderr.trim() !== LINKED) return { kind: "failed", failure: { kind: "command", stage: "remove", details: removed.details } };
		via = "unlink";
		const unlinked = await ternPlugin(tern, ["unlink", TERN_PLUGIN_ID, "--json"], env);
		if (unlinked.kind === "failure") return { kind: "failed", failure: { kind: "command", stage: "unlink", details: unlinked.details } };
	}

	const after = await listed(tern, env, "verify");
	if (typeof after !== "boolean") return after;
	if (after) return { kind: "failed", failure: { kind: "verification", message: `Tern still lists ${TERN_PLUGIN_ID} after ${via}` } };
	return { kind: "removed", via };
}

function diagnostic(text: string): string {
	const bounded = text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]` : text;
	return sanitizeOutputText(bounded);
}

function formatFailure(failure: RemovalFailure): string {
	switch (failure.kind) {
		case "command": {
			const details = failure.details;
			return `omp-unified-exec: removing the old Tern plugin failed at ${failure.stage}\n` +
				`command: ${JSON.stringify(details.command)}\nexit: ${details.exitCode}; signal: ${details.signal}\n` +
				`stdout: ${diagnostic(details.stdout)}\nstderr: ${diagnostic(details.stderr || details.message)}`;
		}
		case "inspection":
			return `omp-unified-exec: removing the old Tern plugin failed at ${failure.stage}: ${diagnostic(failure.message)}`;
		case "verification":
			return `omp-unified-exec: removing the old Tern plugin failed: ${diagnostic(failure.message)}`;
	}
}

export class TernPluginRemovalError extends Error {
	constructor(readonly failure: RemovalFailure) {
		super(formatFailure(failure));
		this.name = "TernPluginRemovalError";
	}
}

/** omp awaits this during install validation and ordinary loading; a failing Tern rejects loading with diagnostics. */
export async function retireTernPlugin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const outcome = await removeTernPlugin(env);
	switch (outcome.kind) {
		case "unavailable":
		case "absent":
		case "removed":
			return;
		case "failed":
			throw new TernPluginRemovalError(outcome.failure);
	}
}
