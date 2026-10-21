/**
 * Tern terminal HUD (fork): live view of every exec_command session for omp's
 * native (Tern Surface Protocol) frontend.
 *
 * A terminals segment joins omp's own running-work pill (`omp.hud.pill`,
 * after its agents and jobs segments): a tinted icon and the stored session
 * count, the words in the hover label. omp has no API for pill segments, so
 * the HUD wraps `InteractiveMode.prototype.describeHudPills` once per process
 * and appends a segment component; Tern draws the capsule, the divider and
 * every chat style. Clicking it opens the Terminals sheet, built like omp's
 * Agents sheet: a `picker` listing the sessions with a status dot, and the
 * selected session's facts and newest output rows as its preview. Open shows
 * its retained history and current screen in a full-pane terminal page, with
 * typed keys sent through ExecSession.write. Kill in the sheet or page uses
 * the same termination path as kill_session.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. The HUD keeps no copy of either: every description re-reads
 * them, and subscriptions only ask omp to describe again.
 *
 * The sheet is an extension custom overlay whose component answers
 * `nativeSheet`, so omp mounts its `picker` description as the modal sheet
 * itself, as it does for the Agents sheet (omp `packages/tui/src/native/backend.ts`);
 * the fork's Tern plugin (`fork-features/tern-plugin/`, CSS only) sets the
 * sheet preview's output rows in the mono face.
 */
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";

import { sanitizeOutputText } from "../src/output-safety.ts";
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
/** Picker action: open the selected session's full-pane terminal page. */
export const OPEN_TERMINAL_ACTION = "open";
/** Picker / page action: kill the session, as `kill_session` does. */
export const KILL_ACTION = "kill";
/** The picker action that closes the sheet: omp's `CLOSE_ACTION` id, which Tern's backdrop and head `esc` send too. */
export const CLOSE_ACTION = "close";
/** The terminal page's way back to the list (Tern's backdrop and head `esc` send `close` too). */
export const BACK_ACTION = "back";
/** Role of the sheet preview's Recent output block, which the fork's Tern plugin sets in the mono face. */
export const TAIL_ROLE = "unified-exec.terminals.tail";
const COMMAND_MAX = 120;

// ---------------- view model ----------------

export type TerminalState =
	| { readonly kind: "running" }
	| {
			readonly kind: "exited";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly failure: string | null;
	  };

export interface TerminalEntry {
	readonly id: number;
	readonly command: string;
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
	const state: TerminalState = session.hasExited
		? { kind: "exited", exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage }
		: { kind: "running" };
	return {
		id: session.id,
		command: oneLine(session.displayCommand),
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

function stateText(state: TerminalState): string {
	if (state.kind === "running") return "running";
	if (state.failure !== null) return `failed: ${oneLine(state.failure)}`;
	if (state.signal !== null) return state.signal;
	return state.exitCode === null ? "exited" : `exit ${state.exitCode}`;
}

/** Status tone, as omp's Agents sheet colours its dots (running accent, done success, failed error). */
function stateTone(state: TerminalState): string {
	if (state.kind === "running") return "accent";
	return exitSucceeded(state) ? "success" : "error";
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
	const label = `${count} terminal${count === 1 ? "" : "s"} · ${running} running`;
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

/** A picker / sheet action button, as omp's `actionButton` builds it. */
function actionButton(label: string, act: string, keys?: string, tone?: string): HudNode {
	return {
		k: "row",
		key: act,
		p: { role: "omp.btn", gap: "xs", align: "center", title: keys ? `${label}  ${keys}` : label, actions: { click: act }, ...(tone ? { tone } : {}) },
		c: [{ k: "text", p: { text: label } }, ...(keys ? [{ k: "kbd", p: { keys: [keys] } }] : [])],
	};
}

/** Picker fact columns, as the Agents sheet's roster shows Cost / Time / …; lower priorities hide first. */
const TERMINAL_COLUMNS = [
	{ id: "size", head: "Size", format: "dim", priority: 2 },
	{ id: "pid", head: "PID", format: "text", priority: 3 },
	{ id: "time", head: "Time", format: "elapsed", priority: 5 },
] as const;

/** Screen rows the preview's Recent output section shows (the newest ones). */
const PREVIEW_TAIL_ROWS = 12;
const SGR = /\x1b\[[0-9;:]*m/g;

/**
 * The newest rows of a screen as plain text, trailing blank rows dropped: the
 * preview is a glance, Open shows the colors at the session's full width.
 */
function screenTail(screen: StyledScreen, rows: number): string[] {
	const lines = screen.text.replace(SGR, "").split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines.slice(-rows);
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

/**
 * The selected session's preview, laid out like the Agents sheet's: a title
 * row (command and a state badge), a facts grid, and a Recent output section
 * with the screen's newest rows.
 */
function describePreview(entry: TerminalEntry): HudNode[] {
	const facts: { k: string; v: unknown }[] = [
		{ k: "Session", v: `#${entry.id}` },
		{ k: "Directory", v: [{ t: shortenHome(entry.cwd), s: "path" }] },
		...(entry.pid !== undefined ? [{ k: "PID", v: String(entry.pid) }] : []),
		{ k: "Size", v: `${entry.screen.view.cols} × ${entry.screen.view.rows}` },
		{ k: "Started", v: [{ t: localDateTime(entry.startedAt), s: "dim" }] },
	];
	const tail = screenTail(entry.screen, PREVIEW_TAIL_ROWS);
	return [
		{
			k: "row",
			key: "title",
			p: { role: "omp.hub.title", gap: "sm", align: "center" },
			c: [
				{ k: "text", key: "name", p: { text: entry.command, role: "omp.picker.title", truncate: "end" } },
				{ k: "badge", key: "state", p: { text: stateText(entry.state), tone: stateTone(entry.state) } },
			],
		},
		{ k: "kv", key: "facts", p: { items: facts, layout: "grid", role: "omp.hub.kv" } },
		// The log path is long and lives in the temp dir: one line cut at its start keeps the file name, the link opens it.
		{
			k: "row",
			key: "log",
			p: { gap: "md", align: "baseline" },
			c: [
				{ k: "text", key: "k", p: { spans: [{ t: "Log", s: "muted" }], shrink: 0 } },
				{
					k: "text",
					key: "v",
					p: { spans: [{ t: entry.logPath, s: "path", href: `file://${entry.logPath}` }], truncate: "start", wrap: "none", grow: 1, title: entry.logPath },
				},
			],
		},
		{
			k: "section",
			key: `output-${itemId(entry.id)}`,
			p: { head: "Recent output" },
			c: [
				tail.length === 0
					? { k: "text", key: "empty", p: { spans: [{ t: "No output yet", s: "dim" }] } }
					: // Plain-text `code` keeps the rows' spacing and scrolls sideways instead of reflowing; the fork's
						// Tern plugin gives the role the mono face (Tern draws preview code in the UI face).
						{ k: "code", key: "tail", p: { text: tail.join("\n"), lang: "text", wrap: false, role: TAIL_ROLE } },
			],
		},
	];
}

/**
 * Pure: the Terminals sheet, built like omp's Agents sheet: a `lg` `picker`
 * titled with an icon, one row per session (status dot, command, state) with
 * Time / PID / Size columns, the selected session laid out like the Agents
 * preview, and the action bar Kill (x, only while running), Close (esc) and
 * Open (enter).
 */
export function describeTerminalsSheet(
	entries: readonly TerminalEntry[],
	selectedId: number | undefined,
	now = Date.now(),
): HudNode {
	const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
	const running = entries.filter((entry) => entry.state.kind === "running").length;
	return {
		k: "picker",
		p: {
			title: "Terminals",
			subtitle: `${running} running · ${entries.length} stored`,
			icon: "terminal",
			noun: "terminals",
			size: "lg",
			layout: "rows",
			preview: "side",
			query: null,
			columns: TERMINAL_COLUMNS,
			items: entries.map((entry) => ({
				id: itemId(entry.id),
				label: entry.command,
				mono: true,
				dot: stateTone(entry.state),
				detail: `#${entry.id} · ${stateText(entry.state)}`,
				facts: {
					// A running session's age ticks Tern-side from the age at send; an exited one is frozen.
					time: entry.state.kind === "running" ? Math.max(0, now - entry.startedAt) : stateText(entry.state),
					pid: entry.pid === undefined ? "—" : String(entry.pid),
					size: `${entry.screen.view.cols}×${entry.screen.view.rows}`,
				},
			})),
			selected: selected ? itemId(selected.id) : null,
			state: "ready",
			empty: "No sessions. Start one with exec_command.",
			actions: [
				{
					id: KILL_ACTION,
					label: "Kill",
					keys: ["x"],
					danger: true,
					...(selected?.state.kind === "running" ? {} : { disabled: selected ? "Already exited" : true }),
				},
				{ id: CLOSE_ACTION, label: "Close", keys: ["esc"], end: true },
				{ id: OPEN_TERMINAL_ACTION, label: "Open", keys: ["enter"], primary: true, ...(selected ? {} : { disabled: true }) },
			],
			focus: "list",
		},
		c: selected ? describePreview(selected) : [],
	};
}

/** The full-pane terminal page's sheet frame: a `full` glass sheet titled with the path back to the list. */
export function terminalPageFrame(entry: TerminalEntry | undefined, id: number): Readonly<Record<string, unknown>> {
	return {
		role: "unified-exec.overlay.terminal",
		size: "full",
		head: [
			{ t: "Terminals · ", s: "muted" },
			{ t: `#${id} ` },
			...(entry ? [{ t: entry.command, s: "mono" }, { t: "  " }, { t: stateText(entry.state), s: stateTone(entry.state) }] : [{ t: "removed", s: "muted" }]),
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
				{ k: "text", key: "gone", p: { spans: [{ t: "This terminal is no longer stored.", s: "dim" }] } },
				{ k: "row", key: "actions", p: { role: "omp.actions", gap: "sm", align: "center" }, c: [{ k: "spacer", p: { grow: 1 } }, actionButton("Back", BACK_ACTION, "esc")] },
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
					{ k: "text", key: "note", p: { spans: [{ t: running ? "Keys go to the terminal" : "Session finished", s: "dim" }] } },
					{ k: "spacer", p: { grow: 1 } },
					...(running ? [actionButton("Kill", KILL_ACTION, undefined, "error")] : []),
					actionButton("Back", BACK_ACTION, "esc"),
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

/** How the Terminals sheet was left. */
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

/**
 * The Terminals sheet, an extension custom overlay. `nativeSheet` makes omp
 * mount the `picker` description as the modal sheet; it holds focus, so
 * esc / ↑ / ↓ / enter / x arrive in `handleInput`.
 */
class TerminalsSheet implements Component {
	private described: HudNode | undefined;
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
		private selectedId: number | undefined,
		private readonly done: (result: SheetResult) => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, this.changed, () => this.selectedId);
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

	nativeSheet(): boolean {
		return true;
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
 * opens the Terminals sheet; Open replaces it with the session's terminal
 * page, whose Back reopens the sheet on the same session. At most one of them
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
