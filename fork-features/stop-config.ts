/**
 * The `omp-unified-exec` section of the omomp configuration: how the notice
 * dispatcher decides that the main agent has stopped for good, and the text
 * of the judge prompt and of the notice it injects.
 *
 * Locations, first valid copy of the section wins (the omomp convention):
 *   1. `<cwd>/.omp/omomp.{yml,yaml,json,toml}`
 *   2. `<agent dir>/omomp.{yml,yaml,json,toml}`
 * A location holding two omomp files, an unreadable file or an invalid section
 * is reported and passed over. The file is read again at every decision, so
 * edits apply to the next stop without a restart.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * - `off`: lifecycle notices (abnormal return, unread, reclaim due, reclaimed)
 *   are not delivered; no stop decision is made.
 * - `auto`: judge when OMP's judge role resolves a model, else the LLM when
 *   `@smol` resolves one, else the todo list.
 * - `judge` / `llm` / `todo`: only that detector; unavailable means no decision.
 */
export type StopMode = "off" | "auto" | "judge" | "llm" | "todo";
const STOP_MODES: Readonly<Record<StopMode, true>> = { off: true, auto: true, judge: true, llm: true, todo: true };

export interface StopConfig {
	readonly mode: StopMode;
	/** What the judge or LLM reads; placeholders {@link JUDGE_PROMPT_FIELDS}. */
	readonly judgePrompt: string;
	/** The injected notice text; placeholders {@link NOTICE_TEMPLATE_FIELDS}. */
	readonly noticeTemplate: string;
}

export const JUDGE_PROMPT_FIELDS = ["last_response", "notices", "todo"] as const;
export type JudgePromptField = (typeof JUDGE_PROMPT_FIELDS)[number];
export const NOTICE_TEMPLATE_FIELDS = ["summary", "items", "instruction", "terminal_count", "notice_count"] as const;
export type NoticeTemplateField = (typeof NOTICE_TEMPLATE_FIELDS)[number];

export const SECTION_ID = "omp-unified-exec";

export const DEFAULT_JUDGE_PROMPT = [
	"A coding agent stopped. Its final response, its todo list and the terminal notices that arrived for it follow.",
	"",
	"Final response:",
	"{last_response}",
	"",
	"Todo list:",
	"{todo}",
	"",
	"Pending terminal notices:",
	"{notices}",
].join("\n");

export const DEFAULT_NOTICE_TEMPLATE = "{summary}\n{items}\n{instruction}";

export const DEFAULT_STOP_CONFIG: StopConfig = {
	mode: "auto",
	judgePrompt: DEFAULT_JUDGE_PROMPT,
	noticeTemplate: DEFAULT_NOTICE_TEMPLATE,
};

export interface ConfigProblem {
	readonly path: string;
	readonly reason: string;
}

export interface StopConfigLoad {
	readonly config: StopConfig;
	/** Where the section came from; undefined when the defaults apply. */
	readonly path: string | undefined;
	readonly problems: readonly ConfigProblem[];
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Parse a template, rejecting placeholders outside `fields`. */
function parseTemplate(value: unknown, key: string, fields: readonly string[]): { kind: "ok"; value: string } | { kind: "error"; reason: string } {
	if (typeof value !== "string" || value.trim().length === 0) return { kind: "error", reason: `${key}: must be a non-empty string` };
	const unknown = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => !fields.includes(name));
	if (unknown.length > 0) {
		return { kind: "error", reason: `${key}: unknown placeholder ${unknown.map((name) => `{${name}}`).join(", ")}; known: ${fields.map((name) => `{${name}}`).join(", ")}` };
	}
	return { kind: "ok", value };
}

/** The section's value; omitted keys take the defaults. */
export function parseStopSection(value: unknown): { kind: "ok"; config: StopConfig } | { kind: "error"; reason: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "error", reason: "section is not a mapping" };
	const record = value as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== "stop" && key !== "judgePrompt" && key !== "noticeTemplate");
	if (extra.length > 0) return { kind: "error", reason: `unknown key ${extra.join(", ")}; known: stop, judgePrompt, noticeTemplate` };
	let mode = DEFAULT_STOP_CONFIG.mode;
	if (record.stop !== undefined) {
		if (typeof record.stop !== "string" || !Object.hasOwn(STOP_MODES, record.stop)) {
			return { kind: "error", reason: `stop: must be one of ${Object.keys(STOP_MODES).join(", ")}` };
		}
		mode = record.stop as StopMode;
	}
	let judgePrompt = DEFAULT_STOP_CONFIG.judgePrompt;
	if (record.judgePrompt !== undefined) {
		const parsed = parseTemplate(record.judgePrompt, "judgePrompt", JUDGE_PROMPT_FIELDS);
		if (parsed.kind === "error") return parsed;
		judgePrompt = parsed.value;
	}
	let noticeTemplate = DEFAULT_STOP_CONFIG.noticeTemplate;
	if (record.noticeTemplate !== undefined) {
		const parsed = parseTemplate(record.noticeTemplate, "noticeTemplate", NOTICE_TEMPLATE_FIELDS);
		if (parsed.kind === "error") return parsed;
		noticeTemplate = parsed.value;
	}
	return { kind: "ok", config: { mode, judgePrompt, noticeTemplate } };
}

/** Single-pass substitution: values are inserted verbatim and never scanned again. */
export function fillTemplate<K extends string>(template: string, values: Readonly<Record<K, string>>): string {
	return template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? values[name as K] : whole));
}

const EXTENSIONS = ["yml", "yaml", "json", "toml"] as const;
type Ext = (typeof EXTENSIONS)[number];

interface BunParsers {
	readonly YAML: { parse(text: string): unknown };
	readonly TOML: { parse(text: string): unknown };
}

function bunParsers(): BunParsers {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const yaml: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "YAML") : undefined;
	const toml: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "TOML") : undefined;
	const hasParse = (value: unknown): value is { parse(text: string): unknown } =>
		typeof value === "object" && value !== null && typeof Reflect.get(value, "parse") === "function";
	if (!hasParse(yaml) || !hasParse(toml)) throw new Error("the Bun runtime lacks Bun.YAML/Bun.TOML");
	return { YAML: yaml, TOML: toml };
}

function parseText(text: string, ext: Ext): unknown {
	switch (ext) {
		case "yml":
		case "yaml":
			return bunParsers().YAML.parse(text);
		case "json":
			return JSON.parse(text);
		case "toml":
			return bunParsers().TOML.parse(text);
	}
}

type Located =
	| { readonly kind: "file"; readonly path: string; readonly ext: Ext }
	| { readonly kind: "none" }
	| { readonly kind: "ambiguous"; readonly paths: readonly string[] };

function locate(dir: string): Located {
	const found = EXTENSIONS.map((ext) => ({ path: join(dir, `omomp.${ext}`), ext })).filter(({ path }) => existsSync(path));
	const [first] = found;
	if (first === undefined) return { kind: "none" };
	if (found.length > 1) return { kind: "ambiguous", paths: found.map(({ path }) => path) };
	return { kind: "file", path: first.path, ext: first.ext };
}

/** The section from the first location holding a valid copy, else the defaults. */
export function loadStopConfig(cwd: string | undefined, agentDir: string): StopConfigLoad {
	const problems: ConfigProblem[] = [];
	const dirs = cwd === undefined ? [agentDir] : [join(cwd, ".omp"), agentDir];
	for (const dir of dirs) {
		const located = locate(dir);
		if (located.kind === "none") continue;
		if (located.kind === "ambiguous") {
			problems.push({ path: dir, reason: `several omomp files: ${located.paths.map((path) => basename(path)).join(", ")}` });
			continue;
		}
		let root: unknown;
		try {
			root = parseText(readFileSync(located.path, "utf8"), located.ext);
		} catch (error) {
			problems.push({ path: located.path, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (typeof root !== "object" || root === null || Array.isArray(root)) {
			problems.push({ path: located.path, reason: "root is not a mapping" });
			continue;
		}
		if (!Object.hasOwn(root, SECTION_ID)) continue;
		const parsed = parseStopSection((root as Record<string, unknown>)[SECTION_ID]);
		if (parsed.kind === "ok") return { config: parsed.config, path: located.path, problems };
		problems.push({ path: `${located.path}#${SECTION_ID}`, reason: parsed.reason });
	}
	return { config: DEFAULT_STOP_CONFIG, path: undefined, problems };
}
