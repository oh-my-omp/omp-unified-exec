/**
 * oh-my-pi (omp) presentation for the unified-exec tools.
 *
 * exec_command / write_stdin / kill_session delegate to omp's own bash
 * renderer through display-only adapters; every other tool uses omp's default
 * card. Model-visible results are untouched. The factory rejects non-omp hosts
 * before activation and initializes the Tern terminal HUD on omp.
 */
import type { ExtensionAPI, ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";

import { sanitizeOutputText } from "../src/output-safety.ts";
import { requireBunRuntime } from "../src/pty.ts";
import type { SessionStore } from "../src/session-store.ts";
import type { TerminalAppearance } from "../src/terminal-screen.ts";
import { truncationMarker } from "../src/tool-result.ts";
import { type CommandApprovalHost, loadCommandApprovalHost } from "./command-approval.ts";
import { loadTernHudHost, mountTerminalHud } from "./tern-terminal-hud.ts";
import { initializeTernPlugin } from "./tern-plugin-install.ts";
import { initializeTerminalUrls } from "./terminal-url.ts";

// ---------------- omp bash renderer contract ----------------

/** Arguments omp's bash renderer projects into its command line. */
export interface ShellArgs {
	readonly command?: string;
	readonly cwd?: string;
}

/** The subset of omp's `BashToolDetails` this adapter fills. */
export interface ShellDetails {
	readonly exitCode?: number;
	readonly wallTimeMs?: number;
	readonly async?: { readonly state: "running"; readonly jobId: string; readonly type: "bash" };
}

export interface ShellResult {
	readonly content: Array<{ type: "text"; text: string }>;
	readonly details: ShellDetails;
	readonly isError: boolean;
}

/** omp render options; only `isPartial` is read, the rest passes through. */
interface RenderOptions {
	readonly isPartial?: boolean;
}

/** Opaque host values passed through unchanged: theme, components, native views. */
type HostValue = unknown;

interface OmpShellRenderer {
	renderCall(args: ShellArgs, options: RenderOptions, theme: HostValue): HostValue;
	renderResult(result: ShellResult, options: RenderOptions, theme: HostValue, args?: ShellArgs): HostValue;
	describeCall(args: ShellArgs, options: RenderOptions): HostValue;
	describeResult(result: ShellResult, options: RenderOptions, args?: ShellArgs): HostValue;
	readonly mergeCallAndResult: boolean;
	readonly inline: boolean;
}

/** Tool arguments as omp hands them to renderers: possibly still streaming, any field missing. */
type StreamedArgs<K extends string> = { readonly [P in K]?: unknown } | undefined;

/** A tool result as omp hands it back: ours (any persisted version) or omp's error result. */
export interface HostResult {
	readonly content?: unknown;
	readonly details?: unknown;
	readonly isError?: unknown;
}

/** Tool hooks omp reads off a registered definition (forwarded by its tool proxy). */
interface OmpToolHooks<K extends string> {
	renderCall(args: StreamedArgs<K>, options: RenderOptions, theme: HostValue): HostValue;
	renderResult(result: HostResult, options: RenderOptions, theme: HostValue, args?: StreamedArgs<K>): HostValue;
	describeCall(args: StreamedArgs<K>, options: RenderOptions): HostValue;
	describeResult(result: HostResult, options: RenderOptions, args?: StreamedArgs<K>): HostValue;
	readonly mergeCallAndResult: boolean;
	readonly inline: boolean;
}

function parseShellRenderer(value: unknown): OmpShellRenderer {
	const bash = value as Partial<Record<keyof OmpShellRenderer, unknown>> | undefined;
	if (
		typeof bash?.renderCall !== "function" ||
		typeof bash.renderResult !== "function" ||
		typeof bash.describeCall !== "function" ||
		typeof bash.describeResult !== "function" ||
		typeof bash.mergeCallAndResult !== "boolean" ||
		typeof bash.inline !== "boolean"
	) {
		throw new Error(
			"omp-unified-exec: @oh-my-pi/pi-tui/tools toolRenderers.bash no longer provides renderCall/renderResult/describeCall/describeResult/mergeCallAndResult/inline; requalify fork-features/omp-presentation.ts for this omp version",
		);
	}
	return bash as OmpShellRenderer;
}

// ---------------- result model ----------------

/** What a unified-exec result means for display, parsed from persisted details. */
export type ResultView =
	| { readonly kind: "streaming"; readonly output: string }
	| {
			readonly kind: "backgrounded";
			readonly output: string;
			readonly sessionId: number;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "exited";
			readonly output: string;
			readonly exitCode: number | undefined;
			readonly signal: string | undefined;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "killed";
			readonly output: string;
			readonly escalated: boolean;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "kill_failed";
			readonly output: string;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	/** Thrown tool errors, unknown sessions and unrecognized legacy details: the result text itself. */
	| { readonly kind: "message"; readonly text: string; readonly isError: boolean };

/** Fields of `OutputResultDetails` the display reads; persisted values are re-checked. */
type PersistedDetails = {
	readonly [K in
		| "operation"
		| "status"
		| "output"
		| "session_id"
		| "exit_code"
		| "signal"
		| "failure_message"
		| "wall_time_seconds"
		| "log_path"
		| "truncation"
		| "escalated"
		| "found"]?: unknown;
};

function messageView(result: HostResult, isError: boolean): ResultView {
	const text = Array.isArray(result.content)
		? result.content
				.map((block: { readonly type?: unknown; readonly text?: unknown } | null) =>
					block?.type === "text" && typeof block.text === "string" ? block.text : "",
				)
				.filter((text) => text.length > 0)
				.join("\n")
		: "";
	return { kind: "message", text: sanitizeOutputText(text), isError };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? sanitizeOutputText(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Pure: unified-exec result (any persisted shape) → display meaning. */
export function parseResultView(result: HostResult, isPartial: boolean): ResultView {
	const details =
		typeof result.details === "object" && result.details !== null ? (result.details as PersistedDetails) : undefined;
	// kill_session on an unknown id answers `found: false` without an error flag; it is still a failed action.
	if (details?.operation === "kill_session" && details.found === false) return messageView(result, true);
	if (typeof details?.output !== "string") return messageView(result, result.isError === true);
	const output = sanitizeOutputText(details.output);
	// Partial updates carry only the cumulative tail; terminal fields arrive with the final result.
	if (isPartial) return { kind: "streaming", output };

	const wallSeconds = optionalNumber(details.wall_time_seconds);
	const wallTimeMs = wallSeconds === undefined ? undefined : wallSeconds * 1000;
	// `truncation` is written only by createOutputEnvelope, next to `output`.
	const marker = truncationMarker(
		details.truncation as TruncationResult | undefined,
		typeof details.log_path === "string" ? details.log_path : undefined,
	);
	const failure = optionalString(details.failure_message);

	switch (details.operation) {
		case "exec_command":
		case "write_stdin": {
			const sessionId = optionalNumber(details.session_id);
			if (details.status === "running" && sessionId !== undefined) {
				return { kind: "backgrounded", output, sessionId, wallTimeMs, marker };
			}
			if (details.status === "exited") {
				return {
					kind: "exited",
					output,
					exitCode: optionalNumber(details.exit_code),
					signal: optionalString(details.signal),
					failure,
					wallTimeMs,
					marker,
				};
			}
			break;
		}
		case "kill_session":
			if (details.status === "killed") {
				return { kind: "killed", output, escalated: details.escalated === true, failure, wallTimeMs, marker };
			}
			if (details.status === "kill_failed") {
				return { kind: "kill_failed", output, failure, wallTimeMs, marker };
			}
			break;
	}
	return messageView(result, result.isError === true);
}

function withNotices(output: string, notices: ReadonlyArray<string | null | undefined>): string {
	const present = notices.filter((notice): notice is string => Boolean(notice));
	if (present.length === 0) return output;
	const body = output.replace(/\n+$/, "");
	return body ? `${body}\n\n${present.join("\n")}` : present.join("\n");
}

function shellResult(text: string, details: ShellDetails, isError: boolean): ShellResult {
	return { content: [{ type: "text", text }], details, isError };
}

/** Pure: display meaning → the result omp's bash renderer draws. */
export function toShellResult(view: ResultView): ShellResult {
	switch (view.kind) {
		case "streaming":
			return shellResult(view.output, {}, false);
		case "backgrounded":
			return shellResult(
				withNotices(view.output, [view.marker]),
				{
					wallTimeMs: view.wallTimeMs,
					async: { state: "running", jobId: `session ${view.sessionId}`, type: "bash" },
				},
				false,
			);
		case "exited":
			return shellResult(
				withNotices(view.output, [
					view.signal && `[signal: ${view.signal}]`,
					view.failure && `[failure: ${view.failure}]`,
					view.marker,
				]),
				{ exitCode: view.exitCode, wallTimeMs: view.wallTimeMs },
				(view.exitCode !== undefined && view.exitCode !== 0) || view.signal !== undefined || view.failure !== undefined,
			);
		case "killed":
			return shellResult(
				withNotices(view.output, [
					view.escalated ? "[escalated to SIGKILL]" : null,
					view.failure && `[failure: ${view.failure}]`,
					view.marker,
				]),
				{ wallTimeMs: view.wallTimeMs },
				false,
			);
		case "kill_failed":
			return shellResult(
				withNotices(view.output, [`[kill failed: ${view.failure ?? "process still running"}]`, view.marker]),
				{ wallTimeMs: view.wallTimeMs },
				true,
			);
		case "message":
			return shellResult(view.text, {}, view.isError);
	}
}

// ---------------- argument model ----------------

function base64ByteLength(b64: string): number {
	const compact = b64.replace(/\s+/g, "");
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function stringifyChars(chars: string): string {
	const escaped = chars
		.replace(/\x03/g, "^C")
		.replace(/\x04/g, "^D")
		.replace(/\x1b/g, "^[")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	const safe = sanitizeOutputText(escaped);
	return safe.length > 40 ? `${safe.slice(0, 37)}…` : safe;
}

/** Pure: streamed exec_command args → bash command line. */
export function execShellArgs(args: StreamedArgs<"cmd" | "workdir">): ShellArgs {
	return {
		command: typeof args?.cmd === "string" ? args.cmd : undefined,
		cwd: typeof args?.workdir === "string" && args.workdir.length > 0 ? args.workdir : undefined,
	};
}

/** Pure: write_stdin args → a bash comment naming the action, never executable bytes. */
export function writeStdinShellArgs(args: StreamedArgs<"session_id" | "chars" | "chars_b64">): ShellArgs {
	const target = typeof args?.session_id === "number" ? `session ${args.session_id}` : "session ?";
	if (typeof args?.chars === "string" && args.chars.length > 0) {
		return { command: `# stdin → ${target}: "${stringifyChars(args.chars)}"` };
	}
	if (typeof args?.chars_b64 === "string" && args.chars_b64.length > 0) {
		return { command: `# stdin → ${target}: ${base64ByteLength(args.chars_b64)} bytes` };
	}
	return { command: `# stdin → ${target}: (input required)` };
}

/** Pure: kill_session args → a bash comment naming the action. */
export function killShellArgs(args: StreamedArgs<"session_id" | "signal">): ShellArgs {
	const target = typeof args?.session_id === "number" ? `session ${args.session_id}` : "session ?";
	return { command: `# kill ${target} (${optionalString(args?.signal) ?? "SIGTERM"})` };
}

// ---------------- registration ----------------

function delegateToShell<K extends string>(
	bash: OmpShellRenderer,
	adaptArgs: (args: StreamedArgs<K>) => ShellArgs,
): OmpToolHooks<K> {
	const adaptResult = (result: HostResult, options: RenderOptions): ShellResult =>
		toShellResult(parseResultView(result, options.isPartial === true));
	return {
		renderCall: (args, options, theme) => bash.renderCall(adaptArgs(args), options, theme),
		renderResult: (result, options, theme, args) =>
			bash.renderResult(adaptResult(result, options), options, theme, adaptArgs(args)),
		describeCall: (args, options) => bash.describeCall(adaptArgs(args), options),
		describeResult: (result, options, args) => {
			const shell = adaptResult(result, options);
			const view = bash.describeResult(shell, options, adaptArgs(args)) as { readonly tone?: unknown } | undefined;
			// Tern derives card status from the host result's isError, which stays false for a nonzero
			// exit (an ordinary completion for the model); the view's tone is the display-side failure signal.
			return shell.isError && view !== undefined ? { ...view, tone: view.tone ?? "error" } : view;
		},
		mergeCallAndResult: bash.mergeCallAndResult,
		inline: bash.inline,
	};
}

/** Tools rendered as bash; any other tool uses omp's default card. */
export const SHELL_PRESENTED_TOOLS = ["exec_command", "write_stdin", "kill_session"] as const;
type ShellPresentedTool = (typeof SHELL_PRESENTED_TOOLS)[number];

function isShellPresented(name: string): name is ShellPresentedTool {
	return (SHELL_PRESENTED_TOOLS as readonly string[]).includes(name);
}

/**
 * omp's registration API: bash delegation attached for the shell-presented tools.
 * The bash renderer is required; a missing or reshaped one fails plugin loading.
 */
async function presentOnOmp(pi: ExtensionAPI): Promise<ExtensionAPI> {
	// Dynamic: omp supplies this module at extension load time.
	const { toolRenderers } = await import("@oh-my-pi/pi-tui/tools");
	const bash = parseShellRenderer(toolRenderers.bash);
	const hooks: Record<ShellPresentedTool, OmpToolHooks<string>> = {
		exec_command: delegateToShell(bash, execShellArgs),
		write_stdin: delegateToShell(bash, writeStdinShellArgs),
		kill_session: delegateToShell(bash, killShellArgs),
	};
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		const presented = isShellPresented(definition.name) ? { ...definition, ...hooks[definition.name] } : definition;
		// omp's registerTool takes its own render signatures; Pi's ToolDefinition type cannot express them.
		pi.registerTool(presented as unknown as ToolDefinition);
	};
	return Object.create(pi, { registerTool: { value: registerTool } }) as ExtensionAPI;
}

/** What the extension hands back to host-specific features after activating. */
export interface ActivatedExtension {
	readonly store: SessionStore;
	/** Kill a stored session as `kill_session` does; resolves whether it exited. */
	readonly kill: (id: number) => Promise<boolean>;
}

/**
 * Load omp's active-theme appearance: whether its current theme is light.
 * In Tern omp follows Tern's appearance, the surface the HUD shows screens on.
 */
async function loadOmpAppearance(): Promise<() => TerminalAppearance> {
	// Dynamic: omp supplies this module at extension load time.
	const themeModule: unknown = await import("@oh-my-pi/pi-tui/theme");
	if (
		typeof themeModule !== "object" ||
		themeModule === null ||
		!("isLightTheme" in themeModule) ||
		typeof themeModule.isLightTheme !== "function" ||
		!("getCurrentThemeName" in themeModule) ||
		typeof themeModule.getCurrentThemeName !== "function"
	) {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-tui/theme lacks isLightTheme/getCurrentThemeName");
	}
	const isLightTheme = themeModule.isLightTheme as (name?: string) => boolean;
	const getCurrentThemeName = themeModule.getCurrentThemeName as () => string | undefined;
	return () => (isLightTheme(getCurrentThemeName()) ? "light" : "dark");
}

/** Read omp's effective external shell at spawn time, not an activation-time copy. */
async function loadOmpShellPath(host: ExtensionAPI): Promise<() => string | undefined> {
	// Load with the other omp modules inside the admitted factory.
	const registry: unknown = await import("@oh-my-pi/pi-coding-agent/config/registry");
	if (typeof registry !== "object" || registry === null ||
		!("lookup" in registry) || typeof registry.lookup !== "function") {
		throw new Error("omp-unified-exec: settings registry lacks lookup");
	}
	const handle: unknown = registry.lookup("shellPath");
	const runtime: unknown = "pi" in host ? host.pi : undefined;
	if (typeof handle !== "object" || handle === null ||
		!("get" in handle) || typeof handle.get !== "function" ||
		typeof runtime !== "object" || runtime === null || !("settings" in runtime)) {
		throw new Error("omp-unified-exec: host lacks shellPath setting or pi.settings scope");
	}
	const get = handle.get.bind(handle);
	return () => {
		const value: unknown = get(runtime.settings);
		if (value === undefined) return undefined;
		if (typeof value !== "string") throw new Error("omp-unified-exec: shellPath must be a string or undefined");
		return value.trim() || undefined;
	};
}

/** omp's shared `gh` mutation detector and SQLite view-cache invalidation; the plugin keeps no copy of either. */
async function loadGithubCacheInvalidation(): Promise<(command: string) => void> {
	const module: unknown = await import("@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation");
	if (typeof module !== "object" || module === null ||
		!("invalidateGithubCacheForBashCommand" in module) || typeof module.invalidateGithubCacheForBashCommand !== "function") {
		throw new Error("omp-unified-exec: tools/gh-cache-invalidation lacks invalidateGithubCacheForBashCommand");
	}
	return module.invalidateGithubCacheForBashCommand as (command: string) => void;
}

/**
 * Admit only omp, identified by its injected `arktype` builder, and activate
 * through {@link presentOnOmp} with omp's theme appearance
 * (sessions answer it to OSC 10/11). The awaited factory initializes Tern's
 * normal plugin copy before registering tools/HUD; omp also awaits this
 * factory during package install/force-reinstall validation.
 */
export function withHostPresentation(
	activate: (
		pi: ExtensionAPI,
		appearance?: () => TerminalAppearance,
		shellPath?: () => string | undefined,
		approvalHost?: CommandApprovalHost,
		invalidateGithubCache?: (command: string) => void,
	) => ActivatedExtension,
): (host: ExtensionAPI) => void | Promise<void> {
	return (host) => {
		if (!("arktype" in host)) {
			throw new Error("omp-unified-exec only supports omp (oh-my-pi); the current host is not omp (missing arktype).");
		}
		requireBunRuntime();
		// The omp modules load before activating, so a reshaped omp fails plugin loading with nothing registered.
		return Promise.all([
			presentOnOmp(host), loadTernHudHost(), loadOmpAppearance(), loadOmpShellPath(host), loadCommandApprovalHost(),
			loadGithubCacheInvalidation(),
		]).then(async ([pi, hud, appearance, shellPath, approvalHost, invalidateGithubCache]) => {
			await initializeTernPlugin();
			await initializeTerminalUrls();
			const activated = activate(pi, appearance, shellPath, approvalHost, invalidateGithubCache);
			mountTerminalHud(pi, activated.store, hud, activated.kill);
		});
	};
}
