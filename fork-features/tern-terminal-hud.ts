/**
 * Tern terminal HUD (fork): live view of every exec_command session for omp's
 * native (Tern Surface Protocol) frontend.
 *
 * A terminals segment joins omp's own running-work pill (`omp.hud.pill`,
 * after its agents and jobs segments): a tinted icon and the stored session
 * count, the words in the hover label. omp has no API for pill segments, so
 * the HUD wraps `InteractiveMode.prototype.describeHudPills` once per process
 * and appends a segment component; Tern draws the capsule, the divider and
 * every chat style. Clicking it opens the Terminals view, built like omp's
 * Background jobs view: a centered card with the sessions as a master list
 * (icon, command, elapsed) and the selected session's status row, command,
 * facts and colored output as its detail. Open shows its retained history
 * and current screen in a full-pane terminal page, with typed keys sent
 * through ExecSession.write. Kill in the view or page uses the same
 * termination path as kill_session.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. The HUD keeps no copy of either: every description re-reads
 * them, and subscriptions only ask omp to describe again.
 *
 * The view and the page are extension custom overlays whose components
 * declare a `nativeOverlay` with omp's own roles (`omp.overlay.jobs`,
 * `omp.overlay.console`), so Tern's built-in styles draw them in every theme
 * and chat style without a plugin; the components keep all behavior.
 */
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";

import { formatElapsedUi } from "../src/format-time.ts";
import { sanitizeOutputText } from "../src/output-safety.ts";
import { tr } from "../src/i18n.ts";
import type { ExecSession } from "../src/session.ts";
import type { SessionStore } from "../src/session-store.ts";
import type { StyledScreen } from "../src/terminal-screen.ts";

// ---------------- omp native contract ----------------

function requalify(change: string): Error {
	return new Error(`omp-unified-exec: ${change}; requalify fork-features/tern-terminal-hud.ts for this omp version`);
}

/** omp's process-wide "a TSP surface is live" flag. */
export interface NativeRenderingState {
	isNativeRendering(): boolean;
	onNativeRenderingChange(listener: (on: boolean) => void): () => void;
}

function parseNativeRenderingState(value: { readonly [K in keyof NativeRenderingState]?: unknown }): NativeRenderingState {
	const { isNativeRendering, onNativeRenderingChange } = value;
	if (typeof isNativeRendering !== "function" || typeof onNativeRenderingChange !== "function") {
		throw requalify("@oh-my-pi/pi-tui/native/state no longer provides isNativeRendering/onNativeRenderingChange");
	}
	return {
		isNativeRendering: () => isNativeRendering() === true,
		onNativeRenderingChange: (listener) => onNativeRenderingChange(listener) as () => void,
	};
}

/** The prototype slot of omp's `InteractiveMode` that describes the running-work pill row. */
export interface HudPillsPrototype {
	describeHudPills(this: object): unknown;
}

function isHudPillsPrototype(value: unknown): value is HudPillsPrototype {
	return typeof value === "object" && value !== null && "describeHudPills" in value && typeof value.describeHudPills === "function";
}

/** Parse `@oh-my-pi/pi-coding-agent/modes/interactive-mode`; fails when omp no longer has the pill describer. */
export function parseInteractiveModeModule(value: { readonly InteractiveMode?: unknown }): HudPillsPrototype {
	const mode = value.InteractiveMode;
	const prototype: unknown = typeof mode === "function" ? mode.prototype : undefined;
	if (!isHudPillsPrototype(prototype)) {
		throw requalify("@oh-my-pi/pi-coding-agent/modes/interactive-mode no longer provides InteractiveMode.prototype.describeHudPills");
	}
	return prototype;
}

/** The omp modules the HUD reads, parsed at load so a reshaped omp fails plugin loading. */
export interface TernHudHost {
	readonly native: NativeRenderingState;
	readonly pills: HudPillsPrototype;
}

/** A described node in omp's native view format (TSP node without its wire id). */
export interface HudNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly HudNode[];
	readonly key?: string;
}

/** A native child: a described node, or a component omp describes in its place. */
export type NativeChild = NativeNode | Component;

/** A described node whose children may include components (omp's pill row, decorated). */
export interface NativeNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeChild[];
	readonly key?: string;
}

/** The action a segment click sends (not a Tern built-in action name, which Tern handles itself). */
export const OPEN_ACTION = "unified-exec.terminals.open";
/**
 * View action: open the selected session's full-pane terminal page. Not Tern's
 * built-in `open`, which opens the node's `href`/`path` and, with neither, drops
 * the click before it reaches the component.
 */
export const OPEN_TERMINAL_ACTION = "unified-exec.terminal.open";
/** View / page action: kill the session, as `kill_session` does. */
export const KILL_ACTION = "kill";
/** The view action that closes it: omp's `CLOSE_ACTION` id, which Tern's backdrop and head `esc` send too. */
export const CLOSE_ACTION = "close";
/** The terminal page's way back to the list (Tern's backdrop and head `esc` send `close` too). */
export const BACK_ACTION = "back";
/** The Terminals view's frame: omp's Background jobs overlay role, so Tern lays it out as that view. */
export const VIEW_FRAME = { role: "omp.overlay.jobs", size: "lg", anchor: "center", head: "Terminals" } as const;

function viewFrame(): Readonly<Record<string, unknown>> {
	return { ...VIEW_FRAME, head: tr("Terminals", "终端") };
}
const COMMAND_MAX = 120;
const SGR = /\x1b\[[0-9;:]*m/g;

// ---------------- view model ----------------

export type TerminalState =
	| { readonly kind: "running" }
	| {
			readonly kind: "exited";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly failure: string | null;
			/** Epoch ms the session exited. */
			readonly exitedAt: number;
	  };

export interface TerminalEntry {
	readonly id: number;
	/** The start title exec_command was given, sanitized, for list labels and the page head. */
	readonly title: string;
	/** The command on one line, cut at COMMAND_MAX. */
	readonly command: string;
	/** The whole command, sanitized, for the view's command block. */
	readonly script: string;
	readonly state: TerminalState;
	readonly screen: StyledScreen;
	readonly cwd: string;
	readonly pid: number | undefined;
	/** Epoch ms the session started. */
	readonly startedAt: number;
	readonly logPath: string;
}

function oneLine(command: string): string {
	const line = sanitizeOutputText(command).replace(/\s+/g, " ").trim();
	return line.length <= COMMAND_MAX ? line : `${line.slice(0, COMMAND_MAX - 1)}…`;
}

function terminalEntry(session: ExecSession, screen: StyledScreen): TerminalEntry {
	const exitedAt = session.exitedAt;
	const state: TerminalState = exitedAt === null
		? { kind: "running" }
		: { kind: "exited", exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage, exitedAt };
	return {
		id: session.id,
		title: oneLine(session.title),
		command: oneLine(session.displayCommand),
		script: sanitizeOutputText(session.displayCommand),
		state,
		screen,
		cwd: sanitizeOutputText(session.cwd),
		pid: session.pid,
		startedAt: session.startedAt,
		logPath: sanitizeOutputText(session.logPath),
	};
}

function exitSucceeded(state: Extract<TerminalState, { kind: "exited" }>): boolean {
	return state.exitCode === 0 && state.signal === null && state.failure === null;
}

/** The page head's state words. */
function stateText(state: TerminalState): string {
	if (state.kind === "running") return tr("running", "运行中");
	if (state.failure !== null) return tr(`failed: ${oneLine(state.failure)}`, `失败：${oneLine(state.failure)}`);
	if (state.signal !== null) return state.signal;
	return state.exitCode === null ? tr("exited", "已退出") : tr(`exit ${state.exitCode}`, `退出 ${state.exitCode}`);
}

/** The page head's state span style. */
function stateTone(state: TerminalState): string {
	if (state.kind === "running") return "accent";
	return exitSucceeded(state) ? "success" : "error";
}

/** A state as the Background jobs view shows one: its label, tone and glyph (pulsing while running). */
interface StateLook {
	readonly label: string;
	readonly tone: "pending" | "success" | "error";
	readonly glyph: { readonly t: string; readonly fx?: "pulse" };
}

function stateLook(state: TerminalState): StateLook {
	if (state.kind === "running") return { label: tr("Running", "运行中"), tone: "pending", glyph: { t: "●", fx: "pulse" } };
	if (exitSucceeded(state)) return { label: tr("Exit 0", "退出 0"), tone: "success", glyph: { t: "✓" } };
	const label = state.failure !== null
		? tr("Failed", "失败")
		: state.signal ?? (state.exitCode === null ? tr("Exited", "已退出") : tr(`Exit ${state.exitCode}`, `退出 ${state.exitCode}`));
	return { label, tone: "error", glyph: { t: "✕" } };
}

/** How long the session has run, or ran: frozen at its exit. */
function elapsedMs(entry: TerminalEntry, now: number): number {
	const end = entry.state.kind === "running" ? now : entry.state.exitedAt;
	return Math.max(0, Math.round(end - entry.startedAt));
}

function itemId(id: number): string {
	return `s${id}`;
}

function parseItemId(item: unknown): number | undefined {
	if (typeof item !== "string" || !/^s\d+$/.test(item)) return undefined;
	const id = Number(item.slice(1));
	return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Pure: the terminals segment for `count` stored sessions, `running` of them
 * still running. omp's running-work segment, copied: a row with role
 * `omp.hud.seg`, a tinted icon and the bare count; the words live in the
 * hover label. Tern owns its styling inside omp's pill in every chat style.
 */
export function describeTerminalSegment(count: number, running: number): HudNode {
	const label = tr(
		`${count} terminal${count === 1 ? "" : "s"} · ${running} running`,
		`${count} 个终端 · ${running} 个运行中`,
	);
	return {
		k: "row",
		key: "terminals",
		p: { role: "omp.hud.seg", gap: "xs", align: "center", title: label, aria: label, actions: { click: OPEN_ACTION } },
		c: [
			{ k: "icon", key: "icon", p: { name: "terminal", tone: "success" } },
			{ k: "text", key: "count", p: { spans: [{ t: String(count), s: "num" }], wrap: "none" } },
		],
	};
}

function isNativeNode(value: unknown): value is NativeNode {
	return typeof value === "object" && value !== null && "k" in value && typeof value.k === "string";
}

/** omp's pill when it has no segments of its own (its `describeHudPills` builds the same row). */
const EMPTY_PILL: NativeNode = { k: "row", key: "running", p: { role: "omp.hud.pill", align: "center" }, c: [] };

/**
 * Parse what omp's `describeHudPills` returned: an `omp.hud` row holding at
 * most one `omp.hud.pill` row. Anything else means omp reshaped its pills.
 */
export function parseHudPillsNode(value: unknown): NativeNode {
	const pill = isNativeNode(value) ? value.c?.[0] : undefined;
	if (
		!isNativeNode(value) || value.k !== "row" || value.p?.role !== "omp.hud" || (value.c?.length ?? 0) > 1
		|| (pill !== undefined && !(isNativeNode(pill) && pill.k === "row" && pill.p?.role === "omp.hud.pill"))
	) {
		throw requalify("InteractiveMode.describeHudPills no longer returns an omp.hud row with one omp.hud.pill");
	}
	return value;
}

/**
 * Pure: omp's pill row with `segment` appended as the pill's last segment, a
 * new pill when omp has none, and the row shown. omp's node is not mutated:
 * omp returns the same object while its own segments are unchanged.
 */
export function withTerminalSegment(hud: NativeNode, segment: Component): NativeNode {
	const existing = hud.c?.[0];
	const pill = isNativeNode(existing) ? existing : EMPTY_PILL;
	return { ...hud, p: { ...hud.p, hidden: undefined }, c: [{ ...pill, c: [...(pill.c ?? []), segment] }] };
}

/** An action button, as omp's `actionButton` builds it. */
function actionButton(label: string, act: string, keys?: string, tone?: string): HudNode {
	return {
		k: "row",
		key: act,
		p: { role: "omp.btn", gap: "xs", align: "center", title: keys ? `${label}  ${keys}` : label, actions: { click: act }, ...(tone ? { tone } : {}) },
		c: [{ k: "text", p: { text: label } }, ...(keys ? [{ k: "kbd", p: { keys: [keys] } }] : [])],
	};
}

/** A leading home directory as `~`, as omp's `shortenPath` shows paths. */
function shortenHome(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function localDateTime(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function actionsRow(children: readonly HudNode[]): HudNode {
	return { k: "row", key: "actions", p: { role: "omp.actions", gap: "sm", align: "center" }, c: children };
}

const SPACER: HudNode = { k: "spacer", p: { grow: 1 } };

/** A master-list row, as the Background jobs view lists a job: icon, command, elapsed. */
function describeListItem(entry: TerminalEntry, now: number): HudNode {
	const look = stateLook(entry.state);
	const elapsed = formatElapsedUi(elapsedMs(entry, now));
	return {
		k: "item",
		key: itemId(entry.id),
		p: {
			label: [{ t: entry.title }],
			value: [{ t: elapsed, s: "mono" }],
			icon: "terminal",
			tone: look.tone,
			title: `${entry.title}\n${entry.command}\n${look.label} · exec · #${entry.id}`,
			aria: tr(
				`${entry.title}, ${look.label.toLowerCase()}, ${elapsed}`,
				`${entry.title}，${look.label}，${elapsed}`,
			),
		},
	};
}

/**
 * The selected session's detail, laid out like a job's: a status row (state,
 * elapsed, `exec · #id`, Kill while running and Open), the command, the
 * facts and the session's colored output, following it while it runs.
 */
function describeDetail(entry: TerminalEntry, now: number): HudNode {
	const look = stateLook(entry.state);
	const running = entry.state.kind === "running";
	const age = elapsedMs(entry, now);
	const facts: { k: string; v: unknown }[] = [
		{ k: tr("Directory", "目录"), v: [{ t: shortenHome(entry.cwd), s: "path" }] },
		...(entry.pid !== undefined ? [{ k: "PID", v: [{ t: String(entry.pid), s: "num" }] }] : []),
		{ k: tr("Size", "大小"), v: [{ t: `${entry.screen.view.cols} × ${entry.screen.view.rows}`, s: "num" }] },
		{ k: tr("Started", "启动时间"), v: [{ t: localDateTime(entry.startedAt), s: "dim" }] },
		{ k: tr("Log", "日志"), v: [{ t: entry.logPath, s: "path", href: `file://${entry.logPath}` }] },
	];
	const hasOutput = entry.screen.text.replace(SGR, "").trim() !== "";
	return {
		k: "col",
		key: itemId(entry.id),
		p: { role: "omp.jobs.detail" },
		c: [
			{
				k: "row",
				key: "status",
				p: { role: "omp.jobs.status", gap: "sm", align: "center" },
				c: [
					{ k: "text", key: "state", p: { spans: [look.glyph, { t: ` ${look.label}` }], role: "omp.jobs.state", tone: look.tone, wrap: "none" } },
					// A running session's age ticks Tern-side from the age at send; an exited one is stopped.
					{ k: "elapsed", key: "age", p: { age, ...(running ? {} : { stopped: age }), format: "short", role: "omp.jobs.age", title: running ? tr("Running for", "运行时长") : tr("Ran for", "运行时长") } },
					{ k: "text", key: "id", p: { spans: [{ t: `exec · #${entry.id}`, s: "mono" }], role: "omp.jobs.id", wrap: "none", truncate: "end" } },
					SPACER,
					...(running ? [actionButton(tr("Kill", "结束"), KILL_ACTION, "x", "error")] : []),
					actionButton(tr("Open", "打开"), OPEN_TERMINAL_ACTION, "enter"),
				],
			},
			{ k: "code", key: "command", p: { text: entry.script, lang: "bash", wrap: true, preview: { lines: 4 }, role: "omp.jobs.command" } },
			{ k: "kv", key: "facts", p: { items: facts, role: "omp.jobs.facts" } },
			{
				k: "col",
				key: "out",
				p: { role: "omp.jobs.out", gap: "sm" },
				c: [
					{ k: "text", key: "label", p: { text: tr("Output", "输出"), role: "omp.jobs.label" } },
					hasOutput
						? { k: "ansi", key: `output-${itemId(entry.id)}`, p: { text: entry.screen.text, follow: running, role: "omp.jobs.output", max: { h: "16lines" } } }
						: { k: "text", key: "none", p: { text: running ? tr("No output yet", "暂无输出") : tr("No output", "无输出"), role: "omp.jobs.nooutput" } },
				],
			},
		],
	};
}

/**
 * Pure: the Terminals view's body, built like omp's Background jobs view: a
 * master/detail split (the sessions in id order, the selected one's detail)
 * over a footer with the running/stored summary and Close; with no session,
 * an empty state and Close. The frame is VIEW_FRAME.
 */
export function describeTerminalsSheet(
	entries: readonly TerminalEntry[],
	selectedId: number | undefined,
	now = Date.now(),
): HudNode {
	const close = actionButton(tr("Close", "关闭"), CLOSE_ACTION, "esc");
	const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
	if (!selected) {
		return {
			k: "col",
			c: [
				{
					k: "col",
					key: "empty",
					p: { role: "omp.jobs.empty", align: "center" },
					c: [
						{ k: "icon", key: "icon", p: { name: "terminal" } },
						{ k: "text", key: "title", p: { text: tr("No terminals", "没有终端"), role: "omp.jobs.empty.title" } },
						{ k: "text", key: "note", p: { text: tr("Sessions started with exec_command show up here while they are stored.", "使用 exec_command 启动的会话在存储期间会显示在这里。"), role: "omp.jobs.empty.note", wrap: "word" } },
					],
				},
				actionsRow([SPACER, close]),
			],
		};
	}
	const running = entries.filter((entry) => entry.state.kind === "running").length;
	return {
		k: "col",
		c: [
			{
				k: "row",
				key: "split",
				p: { role: "omp.jobs.split" },
				c: [
					{
						k: "col",
						key: "master",
						p: { role: "omp.jobs.master" },
						c: [{
							k: "list",
							key: "terminals",
							p: { selected: itemId(selected.id), max: { lines: 12 }, actions: { click: "select", dblclick: "activate" } },
							c: entries.map((entry) => describeListItem(entry, now)),
						}],
					},
					describeDetail(selected, now),
				],
			},
			actionsRow([
				{ k: "text", key: "summary", p: { role: "omp.jobs.summary", text: tr(`${running} running · ${entries.length} stored`, `${running} 个运行中 · ${entries.length} 个已存储`), wrap: "none" } },
				SPACER,
				close,
			]),
		],
	};
}

/** The full-pane terminal page's frame: omp's PTY Console role, titled with the path back to the list. */
export function terminalPageFrame(entry: TerminalEntry | undefined, id: number): Readonly<Record<string, unknown>> {
	return {
		role: "omp.overlay.console",
		size: "full",
		head: [
			{ t: tr("Terminals · ", "终端 · "), s: "muted" },
			{ t: `#${id} ` },
			...(entry ? [{ t: entry.title }, { t: "  " }, { t: stateText(entry.state), s: stateTone(entry.state) }] : [{ t: tr("removed", "已移除"), s: "muted" }]),
		],
	};
}

/**
 * Pure: the full-pane terminal page, built like omp's Console sheet: the
 * session's history and screen as colored `ansi` at the session's own width,
 * following its newest row and scrolling back inside itself, then an action
 * bar: a note that keys go to the terminal while it runs, Kill and Back (esc).
 */
export function describeTerminalPage(entry: TerminalEntry | undefined): HudNode {
	if (!entry) {
		return {
			k: "col",
			p: { gap: "sm" },
			c: [
				{ k: "text", key: "gone", p: { spans: [{ t: tr("This terminal is no longer stored.", "此终端已不再存储。"), s: "dim" }] } },
				{ k: "row", key: "actions", p: { role: "omp.actions", gap: "sm", align: "center" }, c: [{ k: "spacer", p: { grow: 1 } }, actionButton(tr("Back", "返回"), BACK_ACTION, "esc")] },
			],
		};
	}
	const running = entry.state.kind === "running";
	// The column fills the sheet and the screen grows into it, so the action bar sits at the bottom like the Console's.
	return {
		k: "col",
		p: { gap: "sm", min: { h: 1 } },
		c: [
			{
				k: "ansi",
				key: `page-${itemId(entry.id)}`,
				p: {
					text: entry.screen.text,
					cols: entry.screen.view.cols,
					follow: true,
					grow: 1,
					// A fraction of the available extent: the screen takes the sheet's height left by the action bar.
					max: { h: 1 },
				},
			},
			{
				k: "row",
				key: "actions",
				p: { role: "omp.actions", gap: "sm", align: "center" },
				c: [
					{ k: "text", key: "note", p: { spans: [{ t: running ? tr("Keys go to the terminal", "按键将发送到终端") : tr("Session finished", "会话已结束"), s: "dim" }] } },
					{ k: "spacer", p: { grow: 1 } },
					...(running ? [actionButton(tr("Kill", "结束"), KILL_ACTION, undefined, "error")] : []),
					actionButton(tr("Back", "返回"), BACK_ACTION, "esc"),
				],
			},
		],
	};
}

// ---------------- components ----------------

function sortedSessions(store: SessionStore): ExecSession[] {
	return store.values().sort((a, b) => a.id - b.id);
}

function entryOf(session: ExecSession | undefined): TerminalEntry | undefined {
	const screen = session?.styledScreen();
	return session && screen ? terminalEntry(session, screen) : undefined;
}

/** What a native event asks of the HUD's components. */
type HudEvent =
	| { readonly kind: "action"; readonly act: string }
	| { readonly kind: "select"; readonly id: number; readonly activate: boolean };

function parseHudEvent(event: unknown): HudEvent | undefined {
	if (typeof event !== "object" || event === null || !("type" in event)) return undefined;
	if (event.type === "action" && "act" in event && typeof event.act === "string") return { kind: "action", act: event.act };
	if ((event.type === "select" || event.type === "activate") && "item" in event) {
		const id = parseItemId(event.item);
		if (id !== undefined) return { kind: "select", id, activate: event.type === "activate" };
	}
	return undefined;
}

/** Kill a stored session the way `kill_session` does; resolves whether it exited. */
export type KillSession = (id: number) => Promise<boolean>;

/** How the Terminals view was left. */
export type SheetResult = { readonly kind: "closed" } | { readonly kind: "open"; readonly id: number };

/** An interactive mode's terminal handle, asked to describe omp's dock again. */
interface RenderTarget {
	requestRender(): void;
}

/** omp's `InteractiveMode#ui` (its TUI): store changes reach omp's dock only through it. */
function renderTargetOf(mode: object): RenderTarget {
	const ui: unknown = "ui" in mode ? mode.ui : undefined;
	const request: unknown = typeof ui === "object" && ui !== null && "requestRender" in ui ? ui.requestRender : undefined;
	if (typeof request !== "function") throw requalify("InteractiveMode no longer has ui.requestRender");
	return { requestRender: () => request.call(ui) };
}

/**
 * The terminals segment inside one interactive mode's pill. omp calls
 * `describe` instead of `render` while Tern renders natively, and only then
 * describes the pill row, so `render` draws nothing. Each mode gets its own
 * component: omp skips a component described twice in one frame.
 */
class TerminalSegment implements Component {
	constructor(private readonly provider: SegmentProvider) {}

	describe(): HudNode {
		return this.provider.segment();
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (parsed?.kind === "action" && parsed.act === OPEN_ACTION) this.provider.open();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

/**
 * One activation's terminals segment for every interactive mode describing
 * omp's pills. The segment description is derived from the store and
 * re-read after each store or exit change; the decorated pill row is
 * memoized per mode on omp's node identity, the segment component is fixed
 * per mode for this provider's lifetime.
 */
class SegmentProvider {
	private node: HudNode | undefined;
	private readonly modes = new WeakMap<object, { readonly segment: TerminalSegment; decorated?: { readonly base: unknown; readonly node: NativeNode } }>();
	private readonly targets = new Map<object, RenderTarget>();
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		readonly open: () => void,
	) {
		this.watch = new SessionWatch(store, this.changed);
	}

	private changed = (): void => {
		this.node = undefined;
		this.requestRender();
	};

	requestRender(): void {
		for (const target of this.targets.values()) target.requestRender();
	}

	segment(): HudNode {
		if (!this.node) {
			let running = 0;
			for (const session of this.store.values()) if (!session.hasExited) running++;
			this.node = describeTerminalSegment(this.store.size, running);
		}
		return this.node;
	}

	/** omp's pill row for `mode` with the terminals segment, or omp's own row when no session is stored. */
	decorate = (mode: object, base: unknown): unknown => {
		if (!this.targets.has(mode)) this.targets.set(mode, renderTargetOf(mode));
		if (this.store.size === 0) return base;
		let entry = this.modes.get(mode);
		if (!entry) {
			entry = { segment: new TerminalSegment(this) };
			this.modes.set(mode, entry);
		}
		const memo = entry.decorated;
		if (memo && memo.base === base) return memo.node;
		const node = withTerminalSegment(parseHudPillsNode(base), entry.segment);
		entry.decorated = { base, node };
		return node;
	};

	/** Stop watching; the caller has already unregistered `decorate`, so omp re-describes its own row. */
	dispose(): void {
		this.watch.dispose();
		this.requestRender();
		this.targets.clear();
	}
}

type DecoratePills = (mode: object, base: unknown) => unknown;

/** The process's pill wrapper: installed once per prototype, delegating to the current activation's decorator. */
interface PillsRegistry {
	decorate: DecoratePills | undefined;
	readonly wrapped: WeakSet<object>;
}

const pillsRegistrySymbol = Symbol.for("omp-unified-exec.tern-hud-pills");
const processGlobal = globalThis as typeof globalThis & { [pillsRegistrySymbol]?: PillsRegistry };
const pillsRegistry: PillsRegistry = processGlobal[pillsRegistrySymbol] ??= { decorate: undefined, wrapped: new WeakSet() };

/**
 * Wrap omp's pill describer once per process. Reloaded activations swap
 * `pillsRegistry.decorate` rather than wrapping again; with no decorator the
 * wrapper returns omp's row unchanged.
 */
export function wrapHudPills(prototype: HudPillsPrototype): void {
	if (pillsRegistry.wrapped.has(prototype)) return;
	const original = prototype.describeHudPills;
	prototype.describeHudPills = function describeHudPills(this: object): unknown {
		const base = original.call(this);
		return pillsRegistry.decorate ? pillsRegistry.decorate(this, base) : base;
	};
	pillsRegistry.wrapped.add(prototype);
}

/** Store and per-session subscriptions shared by the segment, the sheet and the page; each change re-describes. */
class SessionWatch {
	private readonly watches = new Map<number, { readonly exit: () => void; screen: (() => void) | undefined }>();
	private readonly unsubscribeStore: () => void;

	constructor(
		private readonly store: SessionStore,
		private readonly changed: () => void,
		/** The session whose screen to watch; none when absent (the segment only counts). */
		private readonly shown?: () => number | undefined,
	) {
		this.unsubscribeStore = store.subscribe(() => {
			this.sync();
			changed();
		});
		this.sync();
	}

	/** Watch every stored session's exit and only the shown one's screen. */
	sync(): void {
		const sessions = sortedSessions(this.store);
		const shownId = this.shown ? (this.shown() ?? sessions[0]?.id) : undefined;
		const live = new Set<number>();
		for (const session of sessions) {
			live.add(session.id);
			let watch = this.watches.get(session.id);
			if (!watch) {
				watch = { exit: session.onExit(this.changed), screen: undefined };
				this.watches.set(session.id, watch);
			}
			const wantScreen = session.id === shownId;
			if (wantScreen && !watch.screen) watch.screen = session.onScreenChange(this.changed);
			if (!wantScreen && watch.screen) {
				watch.screen();
				watch.screen = undefined;
			}
		}
		for (const [id, watch] of this.watches) {
			if (live.has(id)) continue;
			watch.exit();
			watch.screen?.();
			this.watches.delete(id);
		}
	}

	dispose(): void {
		this.unsubscribeStore();
		for (const watch of this.watches.values()) {
			watch.exit();
			watch.screen?.();
		}
		this.watches.clear();
	}
}

/** How often an open view re-describes while a session runs, so list ages advance (omp's jobs view does the same). */
const VIEW_TICK_MS = 1000;

/**
 * The Terminals view, an extension custom overlay framed as omp's
 * Background jobs view (`VIEW_FRAME`); it holds focus, so esc / ↑ / ↓ /
 * enter / x arrive in `handleInput`.
 */
class TerminalsSheet implements Component {
	get nativeOverlay(): Readonly<Record<string, unknown>> {
		return viewFrame();
	}
	private described: HudNode | undefined;
	private readonly watch: SessionWatch;
	private readonly tick: NodeJS.Timeout;

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
		private selectedId: number | undefined,
		private readonly done: (result: SheetResult) => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, this.changed, () => this.selectedId);
		this.tick = setInterval(() => {
			if (store.values().some((session) => !session.hasExited)) this.changed();
		}, VIEW_TICK_MS);
		this.tick.unref?.();
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private selected(): ExecSession | undefined {
		const sessions = sortedSessions(this.store);
		return sessions.find((session) => session.id === this.selectedId) ?? sessions[0];
	}

	private select(id: number): void {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.watch.sync();
		this.changed();
	}

	private move(delta: number): void {
		const sessions = sortedSessions(this.store);
		if (sessions.length === 0) return;
		const index = Math.max(0, sessions.findIndex((session) => session.id === this.selectedId));
		this.select(sessions[Math.min(sessions.length - 1, Math.max(0, index + delta))]!.id);
	}

	private openSelected(): void {
		const session = this.selected();
		if (session) this.done({ kind: "open", id: session.id });
	}

	private killSelected(): void {
		const session = this.selected();
		if (!session || session.hasExited) return;
		void this.kill(session.id).then(this.changed);
	}

	describe(): HudNode {
		if (!this.described) {
			const entries = sortedSessions(this.store).flatMap((session) => entryOf(session) ?? []);
			this.described = describeTerminalsSheet(entries, this.selectedId);
		}
		return this.described;
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (!parsed) return;
		if (parsed.kind === "select") {
			this.select(parsed.id);
			if (parsed.activate) this.openSelected();
			return;
		}
		if (parsed.act === CLOSE_ACTION) this.done({ kind: "closed" });
		else if (parsed.act === OPEN_TERMINAL_ACTION) this.openSelected();
		else if (parsed.act === KILL_ACTION) this.killSelected();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.done({ kind: "closed" });
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "enter")) this.openSelected();
		else if (data === "x") this.killSelected();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		clearInterval(this.tick);
		this.watch.dispose();
	}
}

const encoder = new TextEncoder();

/**
 * The full-pane terminal page, built like omp's Console sheet: the session's
 * history and screen at full height, keys forwarded to the session while it
 * runs (Esc goes back to the list instead), Kill and Back.
 */
class TerminalPage implements Component {
	private described: HudNode | undefined;
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		private readonly id: number,
		private readonly requestRender: () => void,
		private readonly back: () => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, this.changed, () => id);
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private session(): ExecSession | undefined {
		return this.store.get(this.id);
	}

	get nativeOverlay(): Readonly<Record<string, unknown>> {
		return terminalPageFrame(entryOf(this.session()), this.id);
	}

	describe(): HudNode {
		this.described ??= describeTerminalPage(entryOf(this.session()));
		return this.described;
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (parsed?.kind !== "action") return;
		if (parsed.act === BACK_ACTION || parsed.act === CLOSE_ACTION) this.back();
		else if (parsed.act === KILL_ACTION && this.session() && !this.session()!.hasExited) void this.kill(this.id).then(this.changed);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		const session = this.session();
		if (session && !session.hasExited) session.write(encoder.encode(data));
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		this.watch.dispose();
	}
}

// ---------------- mounting ----------------

/** Load the omp modules the HUD reads; fails when omp no longer provides them. */
export async function loadTernHudHost(): Promise<TernHudHost> {
	// Dynamic: omp supplies these modules at extension load time.
	const [state, modes] = await Promise.all([
		import("@oh-my-pi/pi-tui/native/state"),
		import("@oh-my-pi/pi-coding-agent/modes/interactive-mode"),
	]);
	return { native: parseNativeRenderingState(state), pills: parseInteractiveModeModule(modes) };
}

/**
 * Keep this activation's terminals segment in omp's pill exactly while an
 * interactive session renders natively; the segment itself shows only while
 * the store holds a session, and the ANSI TUI never sees it. A segment click
 * opens the Terminals view; Open replaces it with the session's terminal
 * page, whose Back reopens the view on the same session. At most one of them
 * is open.
 */
export function mountTerminalHud(pi: ExtensionAPI, store: SessionStore, host: TernHudHost, kill: KillSession): void {
	let ui: ExtensionContext["ui"] | undefined;
	let provider: SegmentProvider | undefined;
	let sheetOpen = false;

	const openSheet = async (): Promise<void> => {
		const host = ui;
		if (!host || sheetOpen) return;
		sheetOpen = true;
		try {
			let selected: number | undefined;
			while (ui === host) {
				const result = await host.custom<SheetResult>(
					(tui, _theme, _keybindings, done) =>
						new TerminalsSheet(store, () => tui.requestRender(), selected, done, kill),
					{ overlay: true },
				);
				if (result.kind === "closed" || ui !== host) return;
				selected = result.id;
				await host.custom<void>(
					(tui, _theme, _keybindings, done) =>
						new TerminalPage(store, result.id, () => tui.requestRender(), () => done(), kill),
					{ overlay: true },
				);
			}
		} finally {
			sheetOpen = false;
		}
	};

	const deactivate = (): void => {
		const ended = provider;
		if (!ended) return;
		provider = undefined;
		// A later activation may already own the wrapper; only withdraw this one's decorator.
		if (pillsRegistry.decorate === ended.decorate) pillsRegistry.decorate = undefined;
		ended.dispose();
	};

	const sync = (): void => {
		if (ui === undefined || !host.native.isNativeRendering()) {
			deactivate();
			return;
		}
		if (provider) return;
		provider = new SegmentProvider(store, () => void openSheet());
		wrapHudPills(host.pills);
		pillsRegistry.decorate = provider.decorate;
	};

	host.native.onNativeRenderingChange(sync);
	pi.on("session_start", async (_event, eventCtx) => {
		deactivate();
		ui = eventCtx.hasUI ? eventCtx.ui : undefined;
		sync();
	});
	pi.on("session_shutdown", async () => {
		deactivate();
		ui = undefined;
	});
}
