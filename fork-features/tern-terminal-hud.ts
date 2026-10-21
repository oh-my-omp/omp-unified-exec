/**
 * Tern terminal HUD (fork): live view of every exec_command session for omp's
 * native (Tern Surface Protocol) frontend.
 *
 * A counter pill on omp's native `omp.hud` row (`omp.hud.pill` with one
 * `omp.hud.seg`: a tinted icon and the bare count, the words in the hover
 * label) counts the stored sessions. Clicking it opens the Terminals
 * sheet, built like omp's Agents sheet: a `picker` listing the sessions with
 * a status dot, and the selected session's facts and newest output rows as
 * its preview. Open shows its retained history and current screen in a
 * full-pane terminal page, with typed keys sent through ExecSession.write.
 * Kill in the sheet or page uses the same termination path as kill_session.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. The HUD keeps no copy of either: every description re-reads
 * them, and subscriptions only ask omp to describe again.
 *
 * The widget describes its pill row below omp's editor; the fork's Tern
 * plugin (`fork-features/tern-plugin/`, CSS only) moves that row to the front
 * of omp's dock, a line of its own above omp's pill line. The sheet is an
 * extension custom overlay whose component answers `nativeSheet`, so omp
 * mounts its `picker` description as the modal sheet itself, as it does for
 * the Agents sheet (omp `packages/tui/src/native/backend.ts`).
 */
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";

import { sanitizeOutputText } from "../src/output-safety.ts";
import type { ExecSession } from "../src/session.ts";
import type { SessionStore } from "../src/session-store.ts";
import type { StyledScreen } from "../src/terminal-screen.ts";

// ---------------- omp native contract ----------------

/** omp's process-wide "a TSP surface is live" flag. */
export interface NativeRenderingState {
	isNativeRendering(): boolean;
	onNativeRenderingChange(listener: (on: boolean) => void): () => void;
}

function parseNativeRenderingState(value: { readonly [K in keyof NativeRenderingState]?: unknown }): NativeRenderingState {
	const { isNativeRendering, onNativeRenderingChange } = value;
	if (typeof isNativeRendering !== "function" || typeof onNativeRenderingChange !== "function") {
		throw new Error(
			"omp-unified-exec: @oh-my-pi/pi-tui/native/state no longer provides isNativeRendering/onNativeRenderingChange; requalify fork-features/tern-terminal-hud.ts for this omp version",
		);
	}
	return {
		isNativeRendering: () => isNativeRendering() === true,
		onNativeRenderingChange: (listener) => onNativeRenderingChange(listener) as () => void,
	};
}

/** A described node in omp's native view format (TSP node without its wire id). */
export interface HudNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly HudNode[];
	readonly key?: string;
}

/** The action a pill click sends (not a Tern built-in action name, which Tern handles itself). */
export const OPEN_ACTION = "unified-exec.terminals.open";
/** Picker action: open the selected session's full-pane terminal page. */
export const OPEN_TERMINAL_ACTION = "open";
/** Picker / page action: kill the session, as `kill_session` does. */
export const KILL_ACTION = "kill";
/** The picker action that closes the sheet: omp's `CLOSE_ACTION` id, which Tern's backdrop and head `esc` send too. */
export const CLOSE_ACTION = "close";
/** The terminal page's way back to the list (Tern's backdrop and head `esc` send `close` too). */
export const BACK_ACTION = "back";
const WIDGET_KEY = "unified-exec-terminals";
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
 * Pure: the dock row for `count` stored sessions (at least one: the
 * widget is unmounted otherwise). omp's running-work counter, copied: a row
 * with role `omp.hud`, holding an `omp.hud.pill` with one `omp.hud.seg`
 * segment, a tinted icon and the bare count; the words live in the hover
 * label. Tern owns the row, pill and segment styling in every chat style.
 */
export function describeTerminalPill(count: number): HudNode {
	const label = `${count} terminal${count === 1 ? "" : "s"}`;
	const segment: HudNode = {
		k: "row",
		key: "terminals",
		p: { role: "omp.hud.seg", gap: "xs", align: "center", title: label, aria: label, actions: { click: OPEN_ACTION } },
		c: [
			{ k: "icon", key: "icon", p: { name: "terminal", tone: "success" } },
			{ k: "text", key: "count", p: { spans: [{ t: String(count), s: "num" }], wrap: "none" } },
		],
	};
	return {
		k: "row",
		p: { role: "omp.hud", justify: "end" },
		c: [
			{ k: "row", key: "running", p: { role: "omp.hud.pill", align: "center" }, c: [segment] },
		],
	};
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

/**
 * The dock widget: the counter pill. omp calls `describe` instead
 * of `render` while Tern renders natively; it is only mounted then, so
 * `render` draws nothing.
 */
class TerminalPill implements Component {
	private described: { readonly count: number; readonly node: HudNode } | undefined;

	constructor(
		private readonly store: SessionStore,
		private readonly open: () => void,
		private readonly requestRender: () => void,
	) {}

	/** The stored sessions changed. */
	membershipChanged(): void {
		this.described = undefined;
		this.requestRender();
	}

	describe(): HudNode {
		const count = this.store.size;
		if (this.described?.count !== count) this.described = { count, node: describeTerminalPill(count) };
		return this.described.node;
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (parsed?.kind !== "action") return;
		if (parsed.act === OPEN_ACTION) this.open();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}
}

/** Store and per-session subscriptions shared by the sheet and the page; each change re-describes. */
class SessionWatch {
	private readonly watches = new Map<number, { readonly exit: () => void; screen: (() => void) | undefined }>();
	private readonly unsubscribeStore: () => void;

	constructor(
		private readonly store: SessionStore,
		private readonly changed: () => void,
		private readonly shown: () => number | undefined,
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
		const shownId = this.shown() ?? sessions[0]?.id;
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

/** Load omp's native rendering flag; fails when omp no longer provides it. */
export async function loadNativeRenderingState(): Promise<NativeRenderingState> {
	// Dynamic: omp supplies this module at extension load time.
	return parseNativeRenderingState(await import("@oh-my-pi/pi-tui/native/state"));
}

/**
 * Keep the pill mounted in omp's dock exactly while omp renders natively and
 * the store holds a session; the ANSI TUI never gets a widget (and so no
 * spacer row). A pill click opens the Terminals sheet; Open replaces it with
 * the session's terminal page, whose Back reopens the sheet on the same
 * session. At most
 * one of them is open.
 */
export function mountTerminalHud(pi: ExtensionAPI, store: SessionStore, native: NativeRenderingState, kill: KillSession): void {
	let ui: ExtensionContext["ui"] | undefined;
	let pill: TerminalPill | undefined;
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

	const unmount = (): void => {
		if (!pill) return;
		pill = undefined;
		// omp disposes the removed widget component.
		ui?.setWidget(WIDGET_KEY, undefined);
	};

	const sync = (): void => {
		const wanted = ui !== undefined && native.isNativeRendering() && store.size > 0;
		if (!wanted) {
			unmount();
			return;
		}
		if (pill) {
			pill.membershipChanged();
			return;
		}
		ui?.setWidget(
			WIDGET_KEY,
			(tui) => {
				pill = new TerminalPill(
					store,
					() => void openSheet(),
					() => tui.requestRender(),
				);
				return pill;
			},
			// `belowEditor`: omp adds no spacer for it (`aboveEditor` gets one);
			// the fork's Tern plugin moves the row above omp's pill line.
			{ placement: "belowEditor" },
		);
	};

	store.subscribe(sync);
	native.onNativeRenderingChange(sync);
	pi.on("session_start", async (_event, eventCtx) => {
		unmount();
		ui = eventCtx.hasUI ? eventCtx.ui : undefined;
		sync();
	});
	pi.on("session_shutdown", async () => {
		unmount();
		ui = undefined;
	});
}
