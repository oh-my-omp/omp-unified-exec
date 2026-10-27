/**
 * Stop detectors: whether the main agent's final response means its work is
 * completely done, so the notices about its returned terminals need no turn.
 *
 * - judge: OMP's judge role chain (`@oh-my-pi/pi-coding-agent/judgment`
 *   `resolveJudge`), billed to the session like OMP's own judgments; one
 *   choice question over the rendered judge prompt.
 * - llm: the chat models of OMP's `smol` role chain, in order, through
 *   `@oh-my-pi/pi-ai` `completeSimple`; the answer's first line is DONE or
 *   NOT_DONE.
 * - todo: omp-todo-more's `omp-todo-more:read` reply; done when the list has
 *   items and every one is completed or abandoned.
 * `auto` picks judge when its chain resolves a model, else llm when `smol`
 * resolves one, else todo. A chosen detector that is unavailable or fails
 * gives no decision, and the notices are delivered as usual.
 */
import { fillTemplate, type JudgePromptField, type StopConfig } from "./stop-config.ts";
import type { StopInput, StopVerdict } from "./terminal-notice.ts";

const DETECT_DEADLINE_MS = 30_000;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

const JUDGE_INSTRUCTIONS =
	"The state holds a coding agent's final response before it stopped, its todo list and the terminal notices waiting for it. Decide whether the response shows the task it was given is completely finished, so nothing in the notices needs the agent.";
const DONE_CRITERION = "The response reports the work finished and delivered, with nothing left to do, verify or wait for.";
const NOT_DONE_CRITERION =
	"The response says work remains, plans further steps, waits for a terminal, background job or the user, reports a failure it has not resolved, or is cut off.";
const LLM_SYSTEM_PROMPT = [
	"You decide whether a coding agent has completely finished its task, from its final response before it stopped.",
	`DONE: ${DONE_CRITERION}`,
	`NOT_DONE: ${NOT_DONE_CRITERION}`,
	"Answer with exactly DONE or NOT_DONE on the first line; one short reason may follow on the next line.",
].join("\n");

// ---- omp internals, parsed once at plugin load ----------------------------

interface HostModel {
	readonly provider: string;
	readonly id: string;
}

interface RoleCandidate {
	readonly model: HostModel;
	readonly thinkingLevel?: string;
}

interface ChainJudge {
	primaryModel(): unknown;
	judge(request: unknown, options: { signal: AbortSignal }): Promise<unknown>;
}

interface AssistantReply {
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly content?: unknown;
}

/** The omp functions the detectors call; a missing one fails plugin loading. */
export interface StopHost {
	readonly getAgentDir: () => string;
	readonly resolveJudge: (deps: unknown) => ChainJudge;
	readonly journalJudgmentUsage: (sessionManager: unknown) => unknown;
	readonly sharedJudgmentCache: () => unknown;
	readonly kindOf: (candidate: RoleCandidate) => string;
	readonly resolveRoleChain: (role: string, settings: unknown, pool: unknown) => readonly RoleCandidate[];
	readonly roleCandidatePool: (role: string, settings: unknown, registry: unknown) => unknown;
	readonly completeSimple: (model: HostModel, context: unknown, options: unknown) => Promise<AssistantReply>;
}

function functionOf(module: unknown, name: string, from: string): (...args: never[]) => unknown {
	const value: unknown = typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}`);
	return value as (...args: never[]) => unknown;
}

/** Load the omp modules the stop detectors use, before any tool registers. */
export async function loadStopHost(): Promise<StopHost> {
	const [agent, judgment, resolver, roles, ai] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-coding-agent/config/model-roles"),
		import("@oh-my-pi/pi-ai"),
	]);
	return {
		getAgentDir: functionOf(agent, "getAgentDir", "@oh-my-pi/pi-coding-agent") as StopHost["getAgentDir"],
		resolveJudge: functionOf(judgment, "resolveJudge", "judgment") as StopHost["resolveJudge"],
		journalJudgmentUsage: functionOf(judgment, "journalJudgmentUsage", "judgment") as StopHost["journalJudgmentUsage"],
		sharedJudgmentCache: functionOf(judgment, "sharedJudgmentCache", "judgment") as StopHost["sharedJudgmentCache"],
		kindOf: functionOf(judgment, "kindOf", "judgment") as StopHost["kindOf"],
		resolveRoleChain: functionOf(resolver, "resolveRoleChain", "config/model-resolver") as StopHost["resolveRoleChain"],
		roleCandidatePool: functionOf(roles, "roleCandidatePool", "config/model-roles") as StopHost["roleCandidatePool"],
		completeSimple: functionOf(ai, "completeSimple", "@oh-my-pi/pi-ai") as StopHost["completeSimple"],
	};
}

// ---- the session the detectors run for -------------------------------------

/** The members of omp's AgentSession the detectors read. */
interface DetectorSession {
	readonly settings: unknown;
	readonly sessionManager: unknown;
	readonly sessionId: string;
	readonly registry: { resolver(model: HostModel, sessionId?: string): unknown };
	readonly metadataForProvider: (provider: string) => unknown;
	readonly telemetry: unknown;
}

/** Parse the bound AgentSession at the boundary; undefined when it lacks a member. */
export function detectorSession(session: unknown): DetectorSession | undefined {
	if (typeof session !== "object" || session === null) return undefined;
	const registry: unknown = Reflect.get(session, "modelRegistry");
	const agent: unknown = Reflect.get(session, "agent");
	const sessionId: unknown = Reflect.get(session, "sessionId");
	if (typeof registry !== "object" || registry === null || typeof Reflect.get(registry, "resolver") !== "function") return undefined;
	if (typeof agent !== "object" || agent === null || typeof Reflect.get(agent, "metadataForProvider") !== "function") return undefined;
	if (typeof sessionId !== "string") return undefined;
	return {
		settings: Reflect.get(session, "settings"),
		sessionManager: Reflect.get(session, "sessionManager"),
		sessionId,
		registry: registry as DetectorSession["registry"],
		metadataForProvider: (provider) => (Reflect.get(agent, "metadataForProvider") as (p: string) => unknown).call(agent, provider),
		telemetry: Reflect.get(agent, "telemetry"),
	};
}

// ---- todo ----------------------------------------------------------------------

type TodoCounts = Readonly<Record<"pending" | "in_progress" | "completed" | "abandoned" | "blocked", number>>;

type TodoRead =
	| {
			readonly kind: "ok";
			readonly objective: string | undefined;
			readonly openItems: readonly { readonly phase: string; readonly title: string }[];
			/** Undefined from an omp-todo-more that predates the counts. */
			readonly counts: TodoCounts | undefined;
	  }
	| { readonly kind: "unavailable" };

function parseCounts(value: unknown): TodoCounts | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const read = (key: keyof TodoCounts): number | undefined => {
		const n: unknown = Reflect.get(value, key);
		return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
	};
	const pending = read("pending");
	const inProgress = read("in_progress");
	const completed = read("completed");
	const abandoned = read("abandoned");
	const blocked = read("blocked");
	if (pending === undefined || inProgress === undefined || completed === undefined || abandoned === undefined || blocked === undefined) return undefined;
	return { pending, in_progress: inProgress, completed, abandoned, blocked };
}

/** Parse an `omp-todo-more:read` reply; anything malformed is unavailable, never an empty list. */
export function parseTodoRead(value: unknown): TodoRead {
	if (typeof value !== "object" || value === null || Reflect.get(value, "kind") !== "ok") return { kind: "unavailable" };
	const openItems: unknown = Reflect.get(value, "openItems");
	if (!Array.isArray(openItems)) return { kind: "unavailable" };
	const items: { phase: string; title: string }[] = [];
	for (const item of openItems as unknown[]) {
		if (typeof item !== "object" || item === null) return { kind: "unavailable" };
		const phase: unknown = Reflect.get(item, "phase");
		const title: unknown = Reflect.get(item, "title");
		if (typeof phase !== "string" || typeof title !== "string") return { kind: "unavailable" };
		items.push({ phase, title });
	}
	const goal: unknown = Reflect.get(value, "goal");
	const objective: unknown = typeof goal === "object" && goal !== null ? Reflect.get(goal, "objective") : undefined;
	return { kind: "ok", objective: typeof objective === "string" ? objective : undefined, openItems: items, counts: parseCounts(Reflect.get(value, "counts")) };
}

/** Done when the list has items and every one is completed or abandoned; blocked items keep it open. */
export function todoVerdict(todo: TodoRead): StopVerdict {
	if (todo.kind === "unavailable") return { kind: "undecided", cause: "unavailable", reason: "todo list unavailable" };
	if (todo.counts === undefined) return { kind: "undecided", cause: "unavailable", reason: "omp-todo-more reply has no counts" };
	const { pending, in_progress, completed, abandoned, blocked } = todo.counts;
	if (pending + in_progress + completed + abandoned + blocked === 0) return { kind: "undecided", cause: "unavailable", reason: "todo list is empty" };
	return { kind: pending + in_progress + blocked === 0 ? "done" : "not_done", detector: "todo" };
}

function todoText(todo: TodoRead): string {
	if (todo.kind === "unavailable") return "(unavailable)";
	const lines: string[] = [];
	if (todo.objective !== undefined) lines.push(`objective: ${todo.objective}`);
	if (todo.counts !== undefined) {
		const c = todo.counts;
		lines.push(`items: ${c.completed} completed, ${c.abandoned} abandoned, ${c.blocked} blocked, ${c.in_progress} in progress, ${c.pending} pending`);
	}
	for (const item of todo.openItems) lines.push(`open: ${item.phase}: ${item.title}`);
	return lines.length > 0 ? lines.join("\n") : "(no todo list)";
}

// ---- judge and llm ----------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/** The first line of an LLM answer as a verdict; undefined when it is neither DONE nor NOT_DONE. */
export function parseLlmAnswer(text: string): "done" | "not_done" | undefined {
	const head = (text.trim().split("\n")[0] ?? "").replace(/^[`*\s]+|[`*\s.]+$/g, "").toUpperCase();
	if (head === "DONE") return "done";
	if (head === "NOT_DONE" || head === "NOT DONE") return "not_done";
	return undefined;
}

function judgeChain(host: StopHost, session: DetectorSession): ChainJudge | undefined {
	const chain = host.resolveJudge({
		settings: session.settings,
		registry: session.registry,
		sessionId: session.sessionId,
		metadataResolver: session.metadataForProvider,
		purpose: "unified-exec-stop",
		onUsage: host.journalJudgmentUsage(session.sessionManager),
		telemetry: session.telemetry,
		cache: host.sharedJudgmentCache(),
	});
	return chain.primaryModel() === undefined ? undefined : chain;
}

async function runJudge(chain: ChainJudge, prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const result = await chain.judge({
		state: prompt,
		questions: { finished: { type: "choice", instructions: JUDGE_INSTRUCTIONS, criteria: { done: DONE_CRITERION, not_done: NOT_DONE_CRITERION } } },
	}, { signal });
	const answers: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "answers") : undefined;
	const finished: unknown = typeof answers === "object" && answers !== null ? Reflect.get(answers, "finished") : undefined;
	const choice: unknown = typeof finished === "object" && finished !== null ? Reflect.get(finished, "choice") : undefined;
	if (choice === "done" || choice === "not_done") return { kind: choice, detector: "judge" };
	return { kind: "undecided", cause: "failed", reason: `judge returned no choice: ${JSON.stringify(finished)}` };
}

function smolModels(host: StopHost, session: DetectorSession): readonly RoleCandidate[] {
	const pool = host.roleCandidatePool("smol", session.settings, session.registry);
	return host.resolveRoleChain("smol", session.settings, pool).filter((candidate) => host.kindOf(candidate) === "online");
}

async function runLlm(host: StopHost, session: DetectorSession, models: readonly RoleCandidate[], prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const failures: string[] = [];
	for (const { model, thinkingLevel } of models) {
		if (signal.aborted) return { kind: "undecided", cause: "failed", reason: "aborted" };
		const label = `${model.provider}/${model.id}`;
		const apiKey = session.registry.resolver(model, session.sessionId);
		const effort: Effort = EFFORTS.find((level) => level === thinkingLevel) ?? "low";
		try {
			const reply = await host.completeSimple(
				model,
				{ systemPrompt: [LLM_SYSTEM_PROMPT], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				thinkingLevel === "off" ? { apiKey, disableReasoning: true, signal } : { apiKey, reasoning: effort, signal },
			);
			if (reply.stopReason === "aborted") return { kind: "undecided", cause: "failed", reason: "aborted" };
			if (reply.stopReason === "error") {
				failures.push(`${label}: ${reply.errorMessage ?? "error"}`);
				continue;
			}
			const answer = parseLlmAnswer(textOf(reply.content));
			if (answer !== undefined) return { kind: answer, detector: "llm" };
			failures.push(`${label}: unparseable answer`);
		} catch (error) {
			if (signal.aborted) return { kind: "undecided", cause: "failed", reason: "aborted" };
			failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { kind: "undecided", cause: "failed", reason: `every @smol model failed: ${failures.join("; ")}` };
}

export interface StopDetectorDeps {
	readonly host: StopHost;
	/** The bound AgentSession, or undefined while unbound. */
	readonly session: () => unknown;
	/** One synchronous `omp-todo-more:read` request for the main agent. */
	readonly readTodo: () => unknown;
}

/** Decide one stop with the configured detector. Never throws for an expected failure; it returns `undecided`. */
export async function detectStop(deps: StopDetectorDeps, config: StopConfig, input: StopInput, signal: AbortSignal): Promise<StopVerdict> {
	if (config.mode === "off") return { kind: "undecided", cause: "unavailable", reason: "stop detection is off" };
	const todo = parseTodoRead(deps.readTodo());
	const prompt = fillTemplate<JudgePromptField>(config.judgePrompt, { last_response: input.lastResponse, notices: input.notices, todo: todoText(todo) });
	if (config.mode === "todo") return todoVerdict(todo);
	const session = detectorSession(deps.session());
	if (session === undefined) return { kind: "undecided", cause: "unavailable", reason: "no bound omp session" };
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(DETECT_DEADLINE_MS)]);
	const judge = config.mode === "llm" ? undefined : judgeChain(deps.host, session);
	if (judge !== undefined) return runJudge(judge, prompt, deadline);
	if (config.mode === "judge") return { kind: "undecided", cause: "unavailable", reason: "the judge role resolves no model" };
	const models = smolModels(deps.host, session);
	if (models.length > 0) return runLlm(deps.host, session, models, prompt, deadline);
	if (config.mode === "llm") return { kind: "undecided", cause: "unavailable", reason: "@smol resolves no model" };
	return todoVerdict(todo);
}
