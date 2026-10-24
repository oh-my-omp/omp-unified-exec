import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BACK_ACTION,
	CLOSE_ACTION,
	describeTerminalPage,
	describeTerminalSegment,
	describeTerminalsSheet,
	KILL_ACTION,
	mountTerminalHud,
	OPEN_ACTION,
	OPEN_TERMINAL_ACTION,
	parseHudPillsNode,
	parseInteractiveModeModule,
	VIEW_FRAME,
	terminalPageFrame,
	withTerminalSegment,
	type HudNode,
	type NativeRenderingState,
	type TerminalEntry,
	type TerminalState,
} from "../fork-features/tern-terminal-hud.ts";
import { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";

function nodesOfKind(node: HudNode, kind: string): HudNode[] {
	return [...(node.k === kind ? [node] : []), ...(node.c ?? []).flatMap((child) => nodesOfKind(child, kind))];
}

function onlyNode(node: HudNode, kind: string): HudNode {
	const matches = nodesOfKind(node, kind);
	assert.equal(matches.length, 1, `expected one ${kind} node`);
	return matches[0]!;
}

function entry(id: number, state: TerminalState): TerminalEntry {
	return {
		id,
		title: `Terminal ${id}`,
		command: `command-${id}`,
		script: `command-${id}\n  --flag ${id}`,
		state,
		cwd: `/tmp/terminal-${id}`,
		pid: 1000 + id,
		startedAt: new Date(2026, 0, 2, 3, 4, 5).getTime(),
		logPath: `/tmp/terminal-${id}.log`,
		screen: {
			text: `screen-${id}`,
			view: { screen: "normal", cols: 80, rows: 24, cursor: { row: 1, col: 1 } },
		},
	};
}

function styledEntry(id: number, cols: number, lines = 3): TerminalEntry {
	const value = entry(id, { kind: "running" });
	const styles = ["31", "1;34", "38;2;12;34;56"];
	return {
		...value,
		screen: {
			text: Array.from({ length: lines }, (_, row) => `\x1b[${styles[row % styles.length]}m${String(id).repeat(cols)}\x1b[0m`).join("\n"),
			view: { ...value.screen.view, cols, rows: lines },
		},
	};
}

/** Exits `ranMs` after entry()'s start. */
function exited(exitCode: number | null, ranMs = 2500): Extract<TerminalState, { kind: "exited" }> {
	return { kind: "exited", exitCode, signal: null, failure: null, exitedAt: new Date(2026, 0, 2, 3, 4, 5).getTime() + ranMs };
}

function ansiText(node: HudNode): string {
	const text = onlyNode(node, "ansi").p?.text;
	assert.ok(typeof text === "string");
	return text;
}

function terminalCount(segment: HudNode): number {
	assert.equal(segment.p?.role, "omp.hud.seg");
	const spans = onlyNode(segment, "text").p?.spans;
	assert.ok(Array.isArray(spans));
	assert.equal(spans.length, 1, "count text has one span");
	const span: unknown = spans[0];
	assert.ok(typeof span === "object" && span !== null && "t" in span && typeof span.t === "string");
	assert.match(span.t, /^\d+$/, "segment text is the bare terminal count");
	return Number(span.t);
}

/** omp's own segment, as `describeHudPills` builds it. */
function ompSegment(key: string, icon: string, act: string): HudNode {
	return {
		k: "row",
		key,
		p: { role: "omp.hud.seg", gap: "xs", align: "center", actions: { click: act } },
		c: [{ k: "icon", key: "icon", p: { name: icon } }, { k: "text", key: "count", p: { spans: [{ t: "1", s: "num" }] } }],
	};
}

/** omp's `describeHudPills` row for its own segments, built as omp 18.12 builds it. */
function ompPillsRow(segments: readonly HudNode[]): HudNode {
	const pills = segments.length > 0 ? [{ k: "row", p: { role: "omp.hud.pill", align: "center" }, c: [...segments], key: "running" }] : [];
	return { k: "row", p: { role: "omp.hud", justify: "end", hidden: pills.length === 0 || undefined }, c: pills };
}

function isComponent(child: unknown): child is HudComponent {
	return typeof child === "object" && child !== null && "describe" in child && typeof child.describe === "function";
}

/** The pill's children of a described `omp.hud` row; none when the row has no pill. */
function pillChildren(row: unknown): readonly unknown[] {
	assert.ok(typeof row === "object" && row !== null && "c" in row && Array.isArray(row.c));
	const pill: unknown = row.c[0];
	if (pill === undefined) return [];
	assert.ok(typeof pill === "object" && pill !== null && "p" in pill && "c" in pill && Array.isArray(pill.c));
	assert.deepEqual(pill.p, { role: "omp.hud.pill", align: "center" });
	return pill.c;
}

function withRole(node: HudNode, role: string): HudNode[] {
	return [...(node.p?.role === role ? [node] : []), ...(node.c ?? []).flatMap((child) => withRole(child, role))];
}

function onlyRole(node: HudNode, role: string): HudNode {
	const matches = withRole(node, role);
	assert.equal(matches.length, 1, `expected one ${role} node`);
	return matches[0]!;
}

/** The master list's selected item key, or null without a list (the empty view). */
function selectedOf(view: HudNode): unknown {
	const lists = nodesOfKind(view, "list");
	return lists.length === 0 ? null : lists[0]!.p?.selected;
}

function listItems(view: HudNode): { readonly key: string | undefined; readonly tone: unknown; readonly value: unknown }[] {
	return nodesOfKind(onlyNode(view, "list"), "item").map((item) => ({ key: item.key, tone: item.p?.tone, value: item.p?.value }));
}

/** The detail's Output: colored ANSI text, or the placeholder text. */
function outputOf(view: HudNode): { readonly kind: "ansi" | "none"; readonly text: unknown; readonly node: HudNode } {
	const out = onlyRole(view, "omp.jobs.out");
	const ansi = withRole(out, "omp.jobs.output");
	if (ansi.length > 0) return { kind: "ansi", text: ansi[0]!.p?.text, node: ansi[0]! };
	const none = onlyRole(out, "omp.jobs.nooutput");
	return { kind: "none", text: none.p?.text, node: none };
}

function factsOf(view: HudNode): { readonly k: string; readonly v: unknown }[] {
	const items = onlyRole(view, "omp.jobs.facts").p?.items;
	assert.ok(Array.isArray(items));
	return items as { readonly k: string; readonly v: unknown }[];
}

function buttonActs(node: HudNode): unknown[] {
	return nodesOfKind(node, "row").filter((row) => row.p?.role === "omp.btn").map((row) => row.p?.actions);
}

describe("terminal HUD pill segment", () => {
	it("shows the stored terminal count as bare text with stored and running counts in its hover label", () => {
		for (const [count, running, label] of [[1, 1, "1 terminal · 1 running"], [2, 0, "2 terminals · 0 running"], [7, 3, "7 terminals · 3 running"]] as const) {
			const view = describeTerminalSegment(count, running);
			assert.equal(terminalCount(view), count);
			assert.equal(view.p?.title, label);
			assert.equal(view.p?.aria, label);
			assert.deepEqual(view.p?.actions, { click: OPEN_ACTION });
		}
	});

	it("appends the segment after omp's own segments without changing omp's row", () => {
		const agents = ompSegment("agents", "users", "agents.open");
		const jobs = ompSegment("jobs", "job", "jobs.open");
		const row = ompPillsRow([agents, jobs]);
		const before = structuredClone(row);
		const segment = { describe: () => describeTerminalSegment(1, 1), render: () => [], invalidate() {} };
		const decorated = withTerminalSegment(parseHudPillsNode(row), segment);
		assert.deepEqual(row, before, "omp's cached row is not mutated");
		assert.equal(decorated.p?.role, "omp.hud");
		assert.equal(decorated.p?.hidden, undefined);
		const children = pillChildren(decorated);
		assert.equal(children.length, 3);
		assert.strictEqual(children[0], agents);
		assert.strictEqual(children[1], jobs);
		assert.strictEqual(children[2], segment, "the terminals segment is the pill's last sibling");
	});

	it("creates and shows omp's pill when omp has no segments of its own", () => {
		const row = ompPillsRow([]);
		assert.equal(row.p?.hidden, true);
		const segment = { describe: () => describeTerminalSegment(1, 1), render: () => [], invalidate() {} };
		const decorated = withTerminalSegment(parseHudPillsNode(row), segment);
		assert.equal(decorated.p?.hidden, undefined);
		assert.deepEqual(decorated.c?.[0] && { ...decorated.c[0], c: undefined }, { k: "row", key: "running", p: { role: "omp.hud.pill", align: "center" }, c: undefined });
		assert.deepEqual(pillChildren(decorated), [segment]);
	});

	it("rejects a reshaped omp with a requalify error", () => {
		const requalify = { message: /requalify fork-features\/tern-terminal-hud\.ts/ };
		for (const row of [
			undefined, null, "row", { k: "col" }, { k: "row", p: { role: "omp.hud.status" } },
			{ k: "row", p: { role: "omp.hud" }, c: [{ k: "row", p: { role: "omp.hud.seg" } }] },
			{ k: "row", p: { role: "omp.hud" }, c: [{ k: "row", p: { role: "omp.hud.pill" } }, { k: "row", p: { role: "omp.hud.pill" } }] },
		]) {
			assert.throws(() => parseHudPillsNode(row), requalify);
		}
		class Reshaped {
			describePills(): unknown {
				return ompPillsRow([]);
			}
		}
		for (const module of [{}, { InteractiveMode: {} }, { InteractiveMode: Reshaped }]) {
			assert.throws(() => parseInteractiveModeModule(module), requalify);
		}
		class ReshapedRow {
			describeHudPills(): unknown {
				return { k: "col" };
			}
		}
		assert.strictEqual(parseInteractiveModeModule({ InteractiveMode: ReshapedRow }), ReshapedRow.prototype);
	});
});

describe("terminal HUD view description", () => {
	it("lists sessions in id order with state tones and elapsed times frozen at exit, over a running/stored summary and Close", () => {
		const entries = [entry(3, { kind: "running" }), entry(11, exited(0, 2500)), entry(19, exited(1, 65_000))];
		const now = entries[0]!.startedAt + 4500;
		const view = describeTerminalsSheet(entries, undefined, now);
		const split = onlyRole(view, "omp.jobs.split");
		assert.deepEqual(split.c?.map((child) => child.p?.role), ["omp.jobs.master", "omp.jobs.detail"]);
		assert.equal(selectedOf(view), "s3", "the first session is selected by default");
		assert.deepEqual(listItems(view), [
			{ key: "s3", tone: "pending", value: [{ t: "4s", s: "mono" }] },
			{ key: "s11", tone: "success", value: [{ t: "2s", s: "mono" }] },
			{ key: "s19", tone: "error", value: [{ t: "1m05s", s: "mono" }] },
		]);
		assert.deepEqual(onlyNode(view, "list").p?.actions, { click: "select", dblclick: "activate" });
		const footer = view.c?.at(-1);
		assert.ok(footer);
		assert.equal(footer.p?.role, "omp.actions");
		assert.equal(onlyRole(footer, "omp.jobs.summary").p?.text, "1 running · 3 stored");
		assert.deepEqual(buttonActs(footer), [{ click: CLOSE_ACTION }]);
	});

	it("shows each state's label, tone and glyph, elapsed age, identity, and Kill only while running beside Open", () => {
		const now = new Date(2026, 0, 2, 3, 4, 5).getTime() + 9000;
		for (const [state, label, tone, glyph] of [
			[{ kind: "running" }, "Running", "pending", { t: "●", fx: "pulse" }],
			[exited(0), "Exit 0", "success", { t: "✓" }],
			[exited(1), "Exit 1", "error", { t: "✕" }],
			[exited(null), "Exited", "error", { t: "✕" }],
			[{ ...exited(0), signal: "SIGTERM" }, "SIGTERM", "error", { t: "✕" }],
			[{ ...exited(0), failure: "spawn failed" }, "Failed", "error", { t: "✕" }],
		] satisfies [TerminalState, string, string, object][]) {
			const view = describeTerminalsSheet([entry(7, state)], 7, now);
			const status = onlyRole(view, "omp.jobs.status");
			const chip = onlyRole(status, "omp.jobs.state");
			assert.deepEqual(chip.p?.spans, [glyph, { t: ` ${label}` }]);
			assert.equal(chip.p?.tone, tone);
			const age = onlyRole(status, "omp.jobs.age");
			assert.equal(age.k, "elapsed");
			if (state.kind === "running") {
				assert.equal(age.p?.age, 9000);
				assert.equal(age.p?.stopped, undefined, "a running age keeps ticking");
			} else {
				assert.equal(age.p?.age, 2500);
				assert.equal(age.p?.stopped, 2500, "an exited age is frozen at its exit");
			}
			assert.deepEqual(onlyRole(status, "omp.jobs.id").p?.spans, [{ t: "exec · #7", s: "mono" }]);
			assert.deepEqual(buttonActs(status), [
				...(state.kind === "running" ? [{ click: KILL_ACTION }] : []),
				{ click: OPEN_TERMINAL_ACTION },
			]);
		}
	});

	it("selects the first session when the requested one is absent", () => {
		const entries = [entry(7, exited(0)), entry(12, { kind: "running" })];
		for (const selectedId of [undefined, 999]) {
			const view = describeTerminalsSheet(entries, selectedId);
			assert.equal(selectedOf(view), "s7");
			assert.equal(onlyRole(view, "omp.jobs.detail").key, "s7");
		}
	});

	it("shows an empty state with only Close and no list or detail", () => {
		const view = describeTerminalsSheet([], undefined);
		assert.equal(selectedOf(view), null);
		assert.equal(withRole(view, "omp.jobs.split").length, 0);
		const empty = onlyRole(view, "omp.jobs.empty");
		assert.equal(onlyRole(empty, "omp.jobs.empty.title").p?.text, "No terminals");
		assert.match(String(onlyRole(empty, "omp.jobs.empty.note").p?.text), /exec_command/);
		assert.deepEqual(buttonActs(view), [{ click: CLOSE_ACTION }]);
	});

	it("shows the whole command in a bash block and the session facts, shortening only a leading home directory", () => {
		const home = homedir();
		for (const [cwd, shown] of [
			[home, "~"],
			[`${home}/projects/terminal`, "~/projects/terminal"],
			[`${home}-other/terminal`, `${home}-other/terminal`],
			["/tmp/terminal", "/tmp/terminal"],
		] as const) {
			const selected = { ...entry(7, { kind: "running" }), cwd, logPath: "/tmp/logs/terminal 7.log" };
			const view = describeTerminalsSheet([selected], selected.id);
			const command = onlyRole(view, "omp.jobs.command");
			assert.equal(command.k, "code");
			assert.equal(command.p?.text, selected.script);
			assert.equal(command.p?.lang, "bash");
			assert.deepEqual(factsOf(view), [
				{ k: "Directory", v: [{ t: shown, s: "path" }] },
				{ k: "PID", v: [{ t: "1007", s: "num" }] },
				{ k: "Size", v: [{ t: "80 × 24", s: "num" }] },
				{ k: "Started", v: [{ t: "2026-01-02 03:04:05", s: "dim" }] },
				{ k: "Log", v: [{ t: "/tmp/logs/terminal 7.log", s: "path", href: "file:///tmp/logs/terminal 7.log" }] },
			]);
		}
		const unknownPid = describeTerminalsSheet([{ ...entry(7, { kind: "running" }), pid: undefined }], 7);
		assert.equal(factsOf(unknownPid).some((fact) => fact.k === "PID"), false, "an unknown process id is left out, not invented");
	});

	it("shows the session's colored screen as Output, following it only while running, and a placeholder for a blank screen", () => {
		for (const state of [{ kind: "running" }, exited(0)] satisfies TerminalState[]) {
			const selected = { ...styledEntry(7, 40, 30), state };
			const output = outputOf(describeTerminalsSheet([selected], 7));
			assert.equal(output.kind, "ansi");
			assert.equal(output.text, selected.screen.text, "the whole retained screen, colors kept");
			assert.equal(output.node.k, "ansi");
			assert.equal(output.node.p?.follow, state.kind === "running");
			assert.deepEqual(output.node.p?.max, { h: "16lines" });
		}
		for (const text of ["", "\x1b[31m \x1b[0m\n\t\n"]) {
			for (const [state, placeholder] of [[{ kind: "running" }, "No output yet"], [exited(0), "No output"]] as const) {
				const value = entry(7, state);
				const output = outputOf(describeTerminalsSheet([{ ...value, screen: { ...value.screen, text } }], 7));
				assert.deepEqual({ kind: output.kind, text: output.text }, { kind: "none", text: placeholder });
			}
		}
	});
});

describe("terminal HUD page description", () => {
	it("frames a full terminal overlay with session id, title, and state in the head", () => {
		for (const state of [{ kind: "running" }, exited(0)] satisfies TerminalState[]) {
			const value = entry(7, state);
			assert.deepEqual(terminalPageFrame(value, value.id), {
				role: "omp.overlay.console",
				size: "full",
				head: [
					{ t: "Terminals · ", s: "muted" },
					{ t: "#7 " },
					{ t: value.title },
					{ t: "  " },
					{ t: state.kind === "running" ? "running" : "exit 0", s: state.kind === "running" ? "accent" : "success" },
				],
			});
		}
	});

	it("describes a following session-keyed ANSI page with Kill only while running and Back on esc", () => {
		for (const state of [{ kind: "running" }, exited(0)] satisfies TerminalState[]) {
			const value = { ...styledEntry(7, 100, 100), state };
			const view = describeTerminalPage(value);
			const screen = onlyNode(view, "ansi");
			assert.equal(screen.key, "page-s7");
			assert.equal(screen.p?.follow, true);
			assert.equal(screen.p?.cols, 100);
			assert.deepEqual(view.p?.min, { h: 1 });
			assert.equal(screen.p?.grow, 1);
			assert.deepEqual(screen.p?.max, { h: 1 });
			assert.equal(ansiText(view), value.screen.text);
			const actions = nodesOfKind(view, "row").find((node) => node.p?.role === "omp.actions");
			assert.ok(actions);
			const buttons = nodesOfKind(actions, "row").filter((node) => node.p?.role === "omp.btn");
			assert.deepEqual(buttons.map((node) => node.p?.actions), [
				...(state.kind === "running" ? [{ click: KILL_ACTION }] : []),
				{ click: BACK_ACTION },
			]);
			const back = buttons.at(-1)!;
			assert.equal(onlyNode(back, "text").p?.text, "Back");
			assert.deepEqual(onlyNode(back, "kbd").p?.keys, ["esc"]);
		}
	});
});

interface HudComponent {
	describe(): HudNode;
	handleNativeEvent(event: unknown): void;
	invalidate(): void;
	dispose?(): void;
}

interface CustomComponent extends HudComponent {
	readonly nativeOverlay?: Readonly<Record<string, unknown>>;
	handleInput(data: string): void;
	dispose(): void;
}

type StubTui = { requestRender(): void };
type CustomFactory = (tui: StubTui, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => CustomComponent;
type CustomCall = {
	readonly component: CustomComponent;
	readonly options: { readonly overlay: boolean };
	readonly promise: Promise<unknown>;
	readonly disposed: boolean;
};
type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

function waitFor(
	condition: () => boolean,
	subscribe: (listener: () => void) => () => void,
	message: string,
): Promise<void> {
	if (condition()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		// Real PTY IO cannot use fake time; this deadline only bounds a missing event.
		const timeout = AbortSignal.timeout(8000);
		const failed = () => {
			unsubscribe();
			reject(new Error(message));
		};
		const changed = () => {
			if (!condition()) return;
			unsubscribe();
			timeout.removeEventListener("abort", failed);
			resolve();
		};
		const unsubscribe = subscribe(changed);
		timeout.addEventListener("abort", failed, { once: true });
		changed();
	});
}

/**
 * Stands in for omp's InteractiveMode: `describeHudPills` returns the same
 * row while omp's own segments are unchanged, as omp's memo does, and `ui`
 * is its TUI. Every harness shares this class, as every omp session shares
 * InteractiveMode, so the process-wide wrapper is installed once.
 */
class FakeInteractiveMode {
	ompSegments: readonly HudNode[] = [];
	renders = 0;
	readonly ui = { requestRender: () => { this.renders++; } };
	private cached: { readonly segments: readonly HudNode[]; readonly node: HudNode } | undefined;

	describeHudPills(): unknown {
		if (this.cached?.segments !== this.ompSegments) this.cached = { segments: this.ompSegments, node: ompPillsRow(this.ompSegments) };
		return this.cached.node;
	}
}

function makeHarness(t: TestContext, initiallyNative = false, ModeClass: new () => FakeInteractiveMode = FakeInteractiveMode) {
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const handlers = new Map<string, Handler[]>();
	const customCalls: CustomCall[] = [];
	const customListeners = new Set<() => void>();
	const killCalls: number[] = [];
	const sessions: ExecSession[] = [];
	const nativeListeners = new Set<(on: boolean) => void>();
	const mode = new ModeClass();
	let nativeOn = initiallyNative;
	let overlay: CustomComponent | undefined;
	let renders = 0;
	const tui: StubTui = { requestRender: () => { renders++; } };
	const ui = {
		custom(factory: CustomFactory, options: { overlay: boolean }): Promise<unknown> {
			let resolve!: (result: unknown) => void;
			const promise = new Promise<unknown>((done) => { resolve = done; });
			let disposed = false;
			const done = (result?: unknown) => {
				if (disposed) return;
				disposed = true;
				// showHookCustom disposes the component before settling its result promise.
				try {
					customComponent.dispose();
					overlay = undefined;
				} finally {
					resolve(result);
				}
			};
			const customComponent = factory(tui, {}, {}, done);
			overlay = customComponent;
			customCalls.push({ component: customComponent, options, promise, get disposed() { return disposed; } });
			for (const listener of customListeners) listener();
			return promise;
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const native: NativeRenderingState = {
		isNativeRendering: () => nativeOn,
		onNativeRenderingChange(listener) {
			nativeListeners.add(listener);
			return () => { nativeListeners.delete(listener); };
		},
	};
	const pills = parseInteractiveModeModule({ InteractiveMode: ModeClass });
	mountTerminalHud(pi, store, { native, pills }, async (id) => {
		killCalls.push(id);
		const session = store.get(id);
		assert.ok(session, "kill targets a stored real session");
		const exited = waitFor(() => session.hasExited, (listener) => session.onExit(listener), "killed child exits");
		session.terminate("SIGKILL");
		await exited;
		store.remove(id);
		return true;
	});

	async function emit(event: string, hasUI = true): Promise<void> {
		const context = { hasUI, ui } as unknown as ExtensionContext;
		const registered = handlers.get(event);
		assert.ok(registered?.length, `${event} handler registered`);
		for (const handler of registered) await handler({}, context);
	}

	t.after(async () => {
		await emit("session_shutdown");
		overlay?.handleNativeEvent({ type: "action", act: CLOSE_ACTION });
		// Keep removed sessions in this list: removing ownership does not kill the child.
		for (const session of sessions) session.terminate("SIGKILL");
		store.terminateAll();
		await Promise.all(sessions.map((session) => waitFor(
			() => session.hasExited, (listener) => session.onExit(listener), "all HUD test children exited",
		)));
		// TerminalScreen.release is idempotent, including after store.remove/terminateAll.
		await Promise.all(sessions.map((session) => session.release()));
	});

	const segments = (): HudComponent[] => pillChildren(mode.describeHudPills()).filter(isComponent);

	return {
		store,
		mode,
		customCalls,
		killCalls,
		waitForCustom(count: number) {
			return waitFor(() => customCalls.length >= count, (listener) => {
				customListeners.add(listener);
				return () => { customListeners.delete(listener); };
			}, `custom overlay ${count} opens`);
		},
		emit,
		get renders() { return renders; },
		/** The terminals segment omp's pill holds this frame. */
		get segment() {
			const found = segments();
			assert.equal(found.length, 1, "omp's pill holds exactly one terminals segment");
			return found[0]!;
		},
		get sheet() {
			assert.ok(overlay, "custom overlay is open");
			assert.equal(overlay.nativeOverlay?.role, VIEW_FRAME.role, "Terminals view is open");
			return overlay;
		},
		get page() {
			assert.equal(overlay?.nativeOverlay?.role, "omp.overlay.console", "terminal page is open");
			return overlay;
		},
		/** Whether omp's pill shows the terminals segment this frame. */
		get mounted() { return segments().length > 0; },
		get sheetOpen() { return overlay?.nativeOverlay?.role === VIEW_FRAME.role; },
		setNative(on: boolean) {
			nativeOn = on;
			for (const listener of nativeListeners) listener(on);
		},
		spawn(command = [process.execPath, "-e", "process.stdin.resume()"], cols = 80, insert = true) {
			const session = ExecSession.spawn(store.allocateId(), { title: "Test terminal", command, cwd: process.cwd(), env: process.env, cols, rows: 24, });
			sessions.push(session);
			assert.equal(session.failureMessage, null, "child spawn succeeds");
			if (insert) store.insert(session);
			return session;
		},
	};
}

describe("terminal HUD lifecycle with real sessions", () => {
	it("adds the segment only after UI, native rendering, and a session are all present", async (t) => {
		const h = makeHarness(t);
		h.spawn();
		assert.equal(h.mounted, false, "no interactive session yet");
		await h.emit("session_start");
		assert.equal(h.mounted, false, "sessions alone add no segment without native rendering");
		h.setNative(true);
		const view = h.segment.describe();
		assert.equal(terminalCount(view), 1);
		assert.deepEqual(view.p?.actions, { click: OPEN_ACTION });
	});

	it("waits for an interactive session_start even when native rendering and a session already exist", async (t) => {
		const h = makeHarness(t, true);
		h.spawn();
		await h.emit("session_start", false);
		assert.equal(h.mounted, false, "a headless session has no segment");
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("joins omp's own pill after its agents and jobs segments, one component per interactive mode", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const agents = ompSegment("agents", "users", "agents.open");
		const jobs = ompSegment("jobs", "job", "jobs.open");
		h.mode.ompSegments = [agents, jobs];
		assert.deepEqual(pillChildren(h.mode.describeHudPills()), [agents, jobs], "no session leaves omp's row as omp built it");
		h.spawn();
		const row = h.mode.describeHudPills();
		const children = pillChildren(row);
		assert.equal(children.length, 3);
		assert.strictEqual(children[0], agents);
		assert.strictEqual(children[1], jobs);
		const segment = children[2];
		assert.ok(isComponent(segment), "the terminals segment is the pill's last sibling");
		assert.strictEqual(h.mode.describeHudPills(), row, "an unchanged omp row keeps the decorated row");
		h.mode.ompSegments = [jobs];
		assert.deepEqual(pillChildren(h.mode.describeHudPills()), [jobs, segment], "the same component follows omp's new row");
		const other = new FakeInteractiveMode();
		const otherSegment = pillChildren(other.describeHudPills())[0];
		assert.ok(isComponent(otherSegment));
		assert.notStrictEqual(otherSegment, segment, "omp skips a component described twice in one frame");
	});

	it("keeps the segment until the last stored session is removed, asking omp to describe again on each change", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.mode.describeHudPills();
		const before = h.mode.renders;
		const first = h.spawn();
		assert.ok(h.mode.renders > before, "a new session asks omp to render");
		const second = h.spawn();
		assert.equal(h.mounted, true);
		h.store.remove(second.id);
		assert.equal(h.store.size, 1);
		assert.equal(terminalCount(h.segment.describe()), 1);
		const removing = h.mode.renders;
		h.store.remove(first.id);
		assert.ok(h.mode.renders > removing, "removal asks omp to render");
		assert.equal(h.mounted, false);
		assert.equal(pillChildren(h.mode.describeHudPills()).length, 0, "omp's empty row is left hidden");
	});

	it("removes the segment when native rendering stops and adds a new one when it resumes", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		const first = h.segment;
		const before = h.mode.renders;
		h.setNative(false);
		assert.ok(h.mode.renders > before, "deactivation asks omp to render its own row");
		assert.equal(h.mounted, false);
		h.setNative(true);
		assert.equal(h.mounted, true);
		assert.notEqual(h.segment, first);
	});

	it("removes the segment on session_shutdown and keeps it out until another session starts", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		await h.emit("session_shutdown");
		assert.equal(h.mounted, false);
		h.setNative(false);
		h.setNative(true);
		h.spawn();
		assert.equal(h.mounted, false);
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("lets a later activation own the pill wrapper without wrapping twice or being withdrawn by the earlier one", async (t) => {
		const earlier = makeHarness(t, true);
		await earlier.emit("session_start");
		earlier.spawn();
		assert.equal(earlier.mounted, true);
		const later = makeHarness(t, true);
		await later.emit("session_start");
		assert.equal(earlier.mounted, false, "the later activation's empty store now decides the segment");
		await earlier.emit("session_shutdown");
		later.spawn();
		assert.equal(later.mounted, true, "the earlier shutdown does not withdraw the later decorator");
		assert.equal(terminalCount(later.segment.describe()), 1, "one wrapper, one segment");
	});

	it("fails with a requalify error when omp's pill describer returns another shape", async (t) => {
		class ReshapedMode extends FakeInteractiveMode {
			override describeHudPills(): unknown {
				return { k: "col" };
			}
		}
		const h = makeHarness(t, true, ReshapedMode);
		await h.emit("session_start");
		assert.deepEqual(h.mode.describeHudPills(), { k: "col" }, "without a session omp's value passes through");
		h.spawn();
		assert.throws(() => h.mode.describeHudPills(), { message: /requalify fork-features\/tern-terminal-hud\.ts/ });
	});

	it("refreshes the segment's stored and running counts for every stored session", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn();
		const segment = h.segment;
		const initial = segment.describe();
		assert.equal(terminalCount(initial), 1);
		assert.strictEqual(segment.describe(), initial);
		h.spawn();
		assert.strictEqual(h.segment, segment);
		assert.equal(terminalCount(segment.describe()), 2);
		h.spawn();
		assert.equal(terminalCount(segment.describe()), 3);
		h.store.remove(first.id);
		assert.strictEqual(h.segment, segment);
		assert.equal(terminalCount(segment.describe()), 2);
		assert.equal(segment.describe().p?.title, "2 terminals · 2 running");
	});

	it("opens exactly one native sheet from the segment and closes, disposes, and reopens it on Close or esc", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		const segment = h.segment;
		for (const event of [null, {}, { type: "action", act: "unrelated" }, { type: "other", act: OPEN_ACTION }]) {
			segment.handleNativeEvent(event);
		}
		assert.equal(h.customCalls.length, 0);
		segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 1);
		assert.deepEqual(h.customCalls[0]?.options, { overlay: true });
		assert.deepEqual(h.sheet.nativeOverlay, VIEW_FRAME);
		segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 1, "a second click while open does nothing");
		const first = h.customCalls[0]!;
		const disposed = t.mock.method(first.component, "dispose");
		h.sheet.handleNativeEvent({ type: "action", act: CLOSE_ACTION });
		await first.promise;
		assert.equal(h.sheetOpen, false);
		assert.equal(first.disposed, true);
		assert.equal(disposed.mock.callCount(), 1);
		segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 2, "settling the custom promise allows another sheet");
		const second = h.customCalls[1]!;
		assert.notEqual(second.component, first.component);
		const escaped = t.mock.method(second.component, "dispose");
		h.sheet.handleInput("\x1b");
		await second.promise;
		assert.equal(h.sheetOpen, false);
		assert.equal(second.disposed, true);
		assert.equal(escaped.mock.callCount(), 1);
		assert.strictEqual(h.segment, segment, "closing the sheet keeps the segment");
	});

	it("lists sessions in id order and changes the plain recent-output preview through select and arrow keys", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn([process.execPath, "-e", "process.stdout.write('\u001b[31mfirst-screen\u001b[0m\\n'); process.stdin.resume()"], 80, false);
		const second = h.spawn([process.execPath, "-e", "process.stdout.write('\u001b[34msecond-screen\u001b[0m\\n'); process.stdin.resume()"], 100, false);
		h.store.insert(second);
		h.store.insert(first);
		const third = h.spawn();
		for (const [session, marker] of [[first, "first-screen"], [second, "second-screen"]] as const) {
			await waitFor(() => session.styledScreen()?.text.includes(marker) === true,
				(listener) => session.onScreenChange(listener), "real PTY output reaches the terminal screen");
		}
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		const sheet = h.sheet;
		const initial = sheet.describe();
		assert.deepEqual(listItems(initial).map((item) => item.key), [`s${first.id}`, `s${second.id}`, `s${third.id}`]);
		assert.equal(selectedOf(initial), `s${first.id}`);
		assert.match(String(outputOf(initial).text), /first-screen/);
		assert.equal(onlyRole(initial, "omp.jobs.detail").key, `s${first.id}`);
		assert.deepEqual(factsOf(initial).find((fact) => fact.k === "PID"), { k: "PID", v: [{ t: String(first.pid), s: "num" }] },
			"the detail's PID comes from the actual PTY session");
		assert.deepEqual(factsOf(initial).find((fact) => fact.k === "Log"), { k: "Log", v: [{ t: first.logPath, s: "path", href: `file://${first.logPath}` }] });
		for (const event of [null, {}, { type: "action", act: "unrelated" }, { type: "select", item: "invalid" }]) {
			sheet.handleNativeEvent(event);
		}
		assert.strictEqual(sheet.describe(), initial, "malformed and unrelated events leave the sheet unchanged");
		const before = h.renders;
		sheet.handleNativeEvent({ type: "select", item: `s${second.id}` });
		const selected = sheet.describe();
		assert.ok(h.renders > before);
		assert.equal(selectedOf(selected), `s${second.id}`);
		assert.equal(onlyRole(selected, "omp.jobs.detail").key, `s${second.id}`);
		assert.match(String(outputOf(selected).text), /second-screen/);
		assert.match(String(outputOf(selected).text), /\x1b\[[0-9;]+m/, "the view's output keeps the real PTY colors");
		sheet.handleInput("\x1b[A");
		assert.equal(selectedOf(sheet.describe()), `s${first.id}`);
		assert.match(String(outputOf(sheet.describe()).text), /first-screen/);
		sheet.handleInput("\x1b[B");
		assert.equal(selectedOf(sheet.describe()), `s${second.id}`);
		assert.match(String(outputOf(sheet.describe()).text), /second-screen/);
		sheet.handleNativeEvent({ type: "action", act: OPEN_TERMINAL_ACTION });
		await h.waitForCustom(2);
		const page = h.page.describe();
		assert.equal(ansiText(page), second.styledScreen()?.text);
		assert.match(ansiText(page), /\x1b\[[0-9;]+m/, "Open retains the same real PTY colors in the full ANSI page");
		assert.deepEqual(page.p?.min, { h: 1 });
		assert.equal(onlyNode(page, "ansi").p?.grow, 1);
		assert.deepEqual(onlyNode(page, "ansi").p?.max, { h: 1 });
	});

	it("re-describes a stored terminal's status dot when its real child exits", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0))"]);
		await waitFor(() => session.styledScreen()?.text.includes("ready") === true,
			(listener) => session.onScreenChange(listener), "real child is ready for stdin");
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		const sheet = h.sheet;
		const initial = sheet.describe();
		assert.deepEqual(listItems(initial).map(({ key, tone }) => ({ key, tone })), [{ key: `s${session.id}`, tone: "pending" }]);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("exit\r")), true);
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "real child exits on stdin");
		const exitedView = sheet.describe();
		assert.ok(h.renders > before);
		assert.notStrictEqual(exitedView, initial);
		assert.deepEqual(listItems(exitedView).map(({ key, tone }) => ({ key, tone })), [{ key: `s${session.id}`, tone: "success" }]);
		assert.equal(onlyRole(exitedView, "omp.jobs.summary").p?.text, "0 running · 1 stored");
		assert.equal(onlyRole(exitedView, "omp.jobs.age").p?.stopped, onlyRole(exitedView, "omp.jobs.age").p?.age, "a real exit freezes the age");
		assert.equal(h.mounted, true);
		assert.equal(terminalCount(h.segment.describe()), 1, "exited sessions remain in the pill count");
		assert.equal(h.segment.describe().p?.title, "1 terminal · 0 running", "the segment re-describes on a real exit");
	});

	it("never reads a released removed session when describing the remaining pill or sheet", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const removed = h.spawn();
		const remaining = h.spawn();
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(selectedOf(h.sheet.describe()), `s${removed.id}`);
		removed.terminate();
		h.store.remove(removed.id);
		await removed.release();
		const forbiddenRead = t.mock.method(removed, "styledScreen", () => { throw new Error("removed screen read after release"); });
		assert.equal(terminalCount(h.segment.describe()), 1);
		assert.equal(selectedOf(h.sheet.describe()), `s${remaining.id}`);
		h.segment.invalidate();
		h.sheet.invalidate();
		assert.doesNotThrow(() => h.segment.describe());
		assert.doesNotThrow(() => h.sheet.describe());
		assert.equal(forbiddenRead.mock.callCount(), 0);
	});

	for (const [openWith, backWith] of [["activate", "esc"], ["enter", "back"], ["open", "close"]] as const) {
		it(`opens a terminal page with ${openWith} and returns with ${backWith} to the same selected session`, async (t) => {
			const h = makeHarness(t, true);
			await h.emit("session_start");
			h.spawn();
			const selected = h.spawn();
			h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
			h.sheet.handleNativeEvent({ type: "select", item: `s${selected.id}` });
			const sheetCall = h.customCalls[0]!;
			if (openWith === "activate") h.sheet.handleNativeEvent({ type: "activate", item: `s${selected.id}` });
			else if (openWith === "enter") h.sheet.handleInput("\r");
			else h.sheet.handleNativeEvent({ type: "action", act: OPEN_TERMINAL_ACTION });
			assert.deepEqual(await sheetCall.promise, { kind: "open", id: selected.id });
			await h.waitForCustom(2);
			assert.equal(sheetCall.disposed, true);
			const page = h.page;
			const pageCall = h.customCalls[1]!;
			assert.deepEqual(pageCall.options, { overlay: true });
			const frame = page.nativeOverlay;
			assert.equal(frame?.role, "omp.overlay.console");
			assert.equal(frame?.size, "full");
			const head = frame?.head;
			assert.ok(Array.isArray(head));
			const headText = head.map((span: unknown) => {
				assert.ok(typeof span === "object" && span !== null && "t" in span && typeof span.t === "string");
				return span.t;
			}).join("");
			assert.ok(headText.includes(`#${selected.id}`));
			assert.ok(headText.includes(selected.title));
			assert.ok(headText.includes("running"));
			const view = page.describe();
			assert.equal(onlyNode(view, "ansi").key, `page-s${selected.id}`);
			assert.equal(onlyNode(view, "ansi").p?.follow, true);
			assert.equal(ansiText(view), selected.styledScreen()?.text);
			assert.deepEqual(nodesOfKind(view, "row").filter((node) => node.p?.role === "omp.btn").map((node) => node.p?.actions),
				[{ click: KILL_ACTION }, { click: BACK_ACTION }]);
			h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
			assert.equal(h.customCalls.length, 2, "a pill click cannot open another sheet over the page");
			if (backWith === "esc") page.handleInput("\x1b");
			else page.handleNativeEvent({ type: "action", act: backWith === "back" ? BACK_ACTION : CLOSE_ACTION });
			assert.equal(await pageCall.promise, undefined);
			await h.waitForCustom(3);
			assert.equal(pageCall.disposed, true);
			assert.equal(selectedOf(h.sheet.describe()), `s${selected.id}`);
			assert.equal(selected.hasExited, false, "page navigation does not kill its session");
		});
	}

	it("kills only running selected sessions through the sheet Kill action and x key", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const finished = h.spawn([process.execPath, "-e", "process.exit(0)"]);
		await waitFor(() => finished.hasExited, (listener) => finished.onExit(listener), "finished session exits");
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		h.sheet.handleNativeEvent({ type: "action", act: KILL_ACTION });
		h.sheet.handleInput("x");
		assert.deepEqual(h.killCalls, [], "an exited selection cannot be killed");
		for (const via of ["action", "key"]) {
			const running = h.spawn();
			h.sheet.handleNativeEvent({ type: "select", item: `s${running.id}` });
			if (via === "action") h.sheet.handleNativeEvent({ type: "action", act: KILL_ACTION });
			else h.sheet.handleInput("x");
			assert.equal(h.killCalls.at(-1), running.id);
			await waitFor(() => h.store.get(running.id) === undefined, (listener) => h.store.subscribe(listener), "kill removes only after child exit");
			assert.equal(running.hasExited, true);
			assert.equal(selectedOf(h.sheet.describe()), `s${finished.id}`);
		}
		assert.equal(h.killCalls.length, 2);
		assert.ok(h.store.get(finished.id), "the finished session remains stored");
	});

	it("writes printable page input to a real stdin terminal while Esc returns without being written", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn([process.execPath, "-e", [
			"process.stdin.setRawMode(true)",
			"process.stdin.on('data', (data) => process.stdout.write(data))",
			"process.stdout.write('input-ready\\n')",
		].join("; ")]);
		await waitFor(() => session.styledScreen()?.text.includes("input-ready") === true,
			(listener) => session.onScreenChange(listener), "stdin terminal is ready with echo disabled");
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		h.sheet.handleInput("\r");
		await h.waitForCustom(2);
		const page = h.page;
		const writes = t.mock.method(session, "write");
		page.handleInput("typed-through-page\r");
		await waitFor(() => session.styledScreen()?.text.includes("typed-through-page") === true,
			(listener) => session.onScreenChange(listener), "the stdin child emits the page's typed line");
		assert.match(ansiText(page.describe()), /typed-through-page/);
		assert.equal(writes.mock.callCount(), 1);
		assert.equal(Buffer.from(writes.mock.calls[0]!.arguments[0]!).toString(), "typed-through-page\r");
		const pageCall = h.customCalls[1]!;
		page.handleInput("\x1b");
		await pageCall.promise;
		await h.waitForCustom(3);
		assert.equal(writes.mock.callCount(), 1, "Esc is navigation, not terminal input");
		assert.equal(pageCall.disposed, true);
		assert.equal(selectedOf(h.sheet.describe()), `s${session.id}`);
		assert.equal(session.hasExited, false);
	});

	it("stops forwarding page input after its real child exits and removes the Kill button", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0))"]);
		await waitFor(() => session.styledScreen()?.text.includes("ready") === true,
			(listener) => session.onScreenChange(listener), "page child is ready");
		h.segment.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		h.sheet.handleInput("\r");
		await h.waitForCustom(2);
		const page = h.page;
		const writes = t.mock.method(session, "write");
		page.handleInput("exit\r");
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "page child exits on input");
		const before = session.styledScreen()?.text;
		const writeCount = writes.mock.callCount();
		page.handleInput("ignored-after-exit");
		assert.equal(writes.mock.callCount(), writeCount, "the page gates writes rather than relying on ExecSession to reject them");
		assert.equal(session.styledScreen()?.text, before);
		assert.deepEqual(nodesOfKind(page.describe(), "row").filter((node) => node.p?.role === "omp.btn").map((node) => node.p?.actions),
			[{ click: BACK_ACTION }]);
		assert.equal(h.killCalls.length, 0);
	});

	it("kills the running terminal through the page Kill button and returns to an empty sheet", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn();
		const pill = h.segment;
		pill.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		h.sheet.handleInput("\r");
		await h.waitForCustom(2);
		const page = h.page;
		page.handleNativeEvent({ type: "action", act: KILL_ACTION });
		await waitFor(() => h.store.get(session.id) === undefined, (listener) => h.store.subscribe(listener), "page kill removes the exited terminal");
		assert.deepEqual(h.killCalls, [session.id]);
		assert.equal(session.hasExited, true);
		assert.equal(h.mounted, false);
		assert.equal(nodesOfKind(page.describe(), "ansi").length, 0);
		const pageCall = h.customCalls[1]!;
		page.handleNativeEvent({ type: "action", act: BACK_ACTION });
		await pageCall.promise;
		await h.waitForCustom(3);
		assert.equal(selectedOf(h.sheet.describe()), null);
		assert.equal(onlyRole(h.sheet.describe(), "omp.jobs.empty.title").p?.text, "No terminals");
	});
});
