import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BACK_ACTION,
	CLOSE_ACTION,
	describeTerminalPill,
	describeTerminalPage,
	describeTerminalsSheet,
	KILL_ACTION,
	mountTerminalHud,
	OPEN_ACTION,
	OPEN_TERMINAL_ACTION,
	TAIL_ROLE,
	terminalPageFrame,
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
		command: `command-${id}`,
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

function exited(exitCode: number | null): TerminalState {
	return { kind: "exited", exitCode, signal: null, failure: null };
}

function segmentOf(node: HudNode): HudNode {
	const segments = nodesOfKind(node, "row").filter((child) => child.p?.role === "omp.hud.seg");
	assert.equal(segments.length, 1, "pill contains exactly one interactive segment");
	return segments[0]!;
}

function ansiText(node: HudNode): string {
	const text = onlyNode(node, "ansi").p?.text;
	assert.ok(typeof text === "string");
	return text;
}

function terminalCount(node: HudNode): number {
	const spans = onlyNode(segmentOf(node), "text").p?.spans;
	assert.ok(Array.isArray(spans));
	assert.equal(spans.length, 1, "count text has one span");
	const span: unknown = spans[0];
	assert.ok(typeof span === "object" && span !== null && "t" in span && typeof span.t === "string");
	assert.match(span.t, /^\d+$/, "pill text is the bare terminal count");
	return Number(span.t);
}

function recentOutputText(node: HudNode): string {
	const output = onlyNode(node, "section");
	assert.deepEqual(output.p, { head: "Recent output" });
	const tail = onlyNode(output, "code");
	assert.equal(tail.key, "tail");
	assert.equal(tail.p?.lang, "text");
	assert.equal(tail.p?.wrap, false);
	assert.equal(tail.p?.role, TAIL_ROLE);
	const text = tail.p?.text;
	assert.ok(typeof text === "string");
	assert.ok(text.split("\n").length <= 12);
	return text;
}

function assertLogRow(node: HudNode, logPath: string): void {
	const log = node.c?.find((child) => child.key === "log");
	assert.deepEqual(log, {
		k: "row",
		key: "log",
		p: { gap: "md", align: "baseline" },
		c: [
			{ k: "text", key: "k", p: { spans: [{ t: "Log", s: "muted" }], shrink: 0 } },
			{ k: "text", key: "v", p: {
				spans: [{ t: logPath, s: "path", href: `file://${logPath}` }],
				truncate: "start", wrap: "none", grow: 1, title: logPath,
			} },
		],
	});
	const facts = onlyNode(node, "kv").p?.items;
	assert.ok(Array.isArray(facts));
	assert.equal(facts.some((fact: unknown) => {
		assert.ok(typeof fact === "object" && fact !== null && "k" in fact);
		return fact.k === "Log";
	}), false, "the Log path is a separate row, not a grid fact");
}

function pickerItems(node: HudNode): { readonly id: string; readonly dot: string }[] {
	assert.equal(node.k, "picker");
	const items = node.p?.items;
	assert.ok(Array.isArray(items));
	return items.map((item: unknown) => {
		assert.ok(typeof item === "object" && item !== null && "id" in item && "dot" in item);
		assert.ok(typeof item.id === "string" && typeof item.dot === "string");
		return { id: item.id, dot: item.dot };
	});
}

describe("terminal HUD pill description", () => {
	it("shows the stored terminal count as bare text with singular or plural hover titles", () => {
		for (const count of [1, 2, 7]) {
			const view = describeTerminalPill(count);
			assert.equal(terminalCount(view), count);
			assert.equal(segmentOf(view).p?.title, `${count} terminal${count === 1 ? "" : "s"}`);
			assert.equal(segmentOf(view).p?.aria, segmentOf(view).p?.title);
		}
	});
});

describe("terminal HUD sheet description", () => {
	it("describes a large Terminals picker with ordered rows, status dots, fact columns, and Kill Close Open actions", () => {
		const entries = [entry(3, { kind: "running" }), entry(11, exited(0)), entry(19, exited(1))];
		const now = entries[0]!.startedAt + 4500;
		const view = describeTerminalsSheet(entries, undefined, now);
		assert.equal(view.k, "picker");
		assert.equal(view.p?.title, "Terminals");
		assert.equal(view.p?.size, "lg");
		assert.equal(view.p?.noun, "terminals");
		assert.equal(view.p?.subtitle, "1 running · 3 stored");
		assert.equal(view.p?.total, undefined);
		assert.equal(view.p?.preview, "side");
		assert.deepEqual(view.p?.columns, [
			{ id: "size", head: "Size", format: "dim", priority: 2 },
			{ id: "pid", head: "PID", format: "text", priority: 3 },
			{ id: "time", head: "Time", format: "elapsed", priority: 5 },
		]);
		assert.deepEqual(view.p?.items, entries.map((value, index) => ({
			id: `s${value.id}`, label: value.command, mono: true,
			dot: ["accent", "success", "error"][index],
			detail: `#${value.id} · ${index === 0 ? "running" : `exit ${index - 1}`}`,
			facts: { time: index === 0 ? 4500 : `exit ${index - 1}`, pid: String(value.pid), size: "80×24" },
		})));
		assert.deepEqual(view.p?.actions, [
			{ id: KILL_ACTION, label: "Kill", keys: ["x"], danger: true },
			{ id: CLOSE_ACTION, label: "Close", keys: ["esc"], end: true },
			{ id: OPEN_TERMINAL_ACTION, label: "Open", keys: ["enter"], primary: true },
		]);
	});

	it("marks failed, signalled, and unknown exits as errors and disables Kill with its reason", () => {
		const states: TerminalState[] = [
			exited(1), exited(null),
			{ kind: "exited", exitCode: 0, signal: "SIGTERM", failure: null },
			{ kind: "exited", exitCode: 0, signal: null, failure: "spawn failed" },
		];
		const view = describeTerminalsSheet(states.map((state, index) => entry(index + 1, state)), undefined);
		assert.deepEqual(pickerItems(view).map((item) => item.dot), states.map(() => "error"));
		assert.deepEqual(view.p?.actions, [
			{ id: KILL_ACTION, label: "Kill", keys: ["x"], danger: true, disabled: "Already exited" },
			{ id: CLOSE_ACTION, label: "Close", keys: ["esc"], end: true },
			{ id: OPEN_TERMINAL_ACTION, label: "Open", keys: ["enter"], primary: true },
		]);
	});

	it("falls back to the first session when the selected session is absent", () => {
		const entries = [entry(7, exited(0)), entry(12, { kind: "running" })];
		for (const selectedId of [undefined, 999]) {
			const view = describeTerminalsSheet(entries, selectedId);
			assert.equal(view.p?.selected, `s${entries[0]!.id}`);
			assert.equal(recentOutputText(view), entries[0]!.screen.text);
		}
	});

	it("shows empty-session copy with no selection or preview and disables Kill and Open", () => {
		const view = describeTerminalsSheet([], undefined);
		assert.deepEqual(view.p?.items, []);
		assert.equal(view.p?.selected, null);
		assert.equal(view.p?.total, undefined);
		assert.equal(view.p?.empty, "No sessions. Start one with exec_command.");
		assert.deepEqual(view.c, []);
		assert.deepEqual(view.p?.actions, [
			{ id: KILL_ACTION, label: "Kill", keys: ["x"], danger: true, disabled: true },
			{ id: CLOSE_ACTION, label: "Close", keys: ["esc"], end: true },
			{ id: OPEN_TERMINAL_ACTION, label: "Open", keys: ["enter"], primary: true, disabled: true },
		]);
	});

	it("describes the selected command, status badge, metadata grid, and session-keyed recent output", () => {
		const entries = [entry(3, { kind: "running" }), entry(11, exited(0)), entry(19, exited(1))];
		const keys: string[] = [];
		for (const [index, selected] of entries.entries()) {
			const view = describeTerminalsSheet(entries, selected.id);
			assert.deepEqual(view.c?.map((node) => node.k), ["row", "kv", "row", "section"]);
			const title = view.c?.[0];
			assert.ok(title);
			assert.equal(title.p?.role, "omp.hub.title");
			assert.equal(onlyNode(title, "text").p?.role, "omp.picker.title");
			assert.equal(onlyNode(title, "text").p?.text, selected.command);
			assert.equal(onlyNode(title, "badge").p?.text, index === 0 ? "running" : `exit ${index - 1}`);
			assert.equal(onlyNode(title, "badge").p?.tone, ["accent", "success", "error"][index]);
			const grid = onlyNode(view, "kv");
			assert.equal(grid.p?.role, "omp.hub.kv");
			assert.equal(grid.p?.layout, "grid");
			assert.deepEqual(grid.p?.items, [
				{ k: "Session", v: `#${selected.id}` },
				{ k: "Directory", v: [{ t: selected.cwd, s: "path" }] },
				{ k: "PID", v: String(selected.pid) },
				{ k: "Size", v: "80 × 24" },
				{ k: "Started", v: [{ t: "2026-01-02 03:04:05", s: "dim" }] },
			]);
			assertLogRow(view, selected.logPath);
			const output = onlyNode(view, "section");
			assert.equal(output.key, `output-s${selected.id}`);
			assert.equal(output.p?.head, "Recent output");
			keys.push(output.key!);
			assert.equal(recentOutputText(view), selected.screen.text);
			assert.equal(nodesOfKind(output, "ansi").length, 0);
		}
		assert.equal(new Set(keys).size, entries.length);
	});

	it("shortens only the leading home directory and shows the full linked log path in its own row", () => {
		const home = homedir();
		for (const [cwd, shown] of [
			[home, "~"],
			[`${home}/projects/terminal`, "~/projects/terminal"],
			[`${home}-other/terminal`, `${home}-other/terminal`],
			["/tmp/terminal", "/tmp/terminal"],
		] as const) {
			const selected = { ...entry(7, { kind: "running" }), cwd, logPath: "/tmp/logs/terminal 7.log" };
			const view = describeTerminalsSheet([selected], selected.id);
			const facts = onlyNode(view, "kv").p?.items;
			assert.ok(Array.isArray(facts));
			const directory: unknown = facts.find((fact: unknown) => {
				assert.ok(typeof fact === "object" && fact !== null && "k" in fact);
				return fact.k === "Directory";
			});
			assert.deepEqual(directory, { k: "Directory", v: [{ t: shown, s: "path" }] });
			assertLogRow(view, selected.logPath);
		}
	});

	it("uses an em dash fact and omits the PID preview row when the process id is unknown", () => {
		const selected = { ...entry(7, { kind: "running" }), pid: undefined };
		const view = describeTerminalsSheet([selected], selected.id, selected.startedAt + 1500);
		const items = view.p?.items;
		assert.ok(Array.isArray(items));
		const item: unknown = items[0];
		assert.ok(typeof item === "object" && item !== null && "facts" in item);
		assert.deepEqual(item.facts, { time: 1500, pid: "—", size: "80×24" });
		const facts = onlyNode(view, "kv").p?.items;
		assert.ok(Array.isArray(facts));
		assert.equal(facts.some((fact: unknown) => {
			assert.ok(typeof fact === "object" && fact !== null && "k" in fact);
			return fact.k === "PID";
		}), false);
	});

	it("shows the newest twelve plain output rows after stripping SGR and trailing blank rows", () => {
		const value = entry(7, { kind: "running" });
		const lines = Array.from({ length: 20 }, (_, row) => row === 15 ? "" : `row-${row}`);
		const selected = { ...value, screen: {
			...value.screen,
			text: `${lines.map((line) => `\x1b[38;2;12;34;56m${line}\x1b[0m`).join("\n")}\n\x1b[31m \x1b[0m\n\x1b[1m\t\x1b[0m\n\x1b[0m\n`,
		} };
		const view = describeTerminalsSheet([selected], selected.id);
		const tail = recentOutputText(view);
		assert.equal(tail, lines.slice(-12).join("\n"));
		assert.equal(tail.split("\n").length, 12);
		assert.equal(tail.includes("\x1b["), false);
		assert.equal(nodesOfKind(view, "ansi").length, 0);
	});

	it("keeps the recent-output section and shows dim No output yet copy for an empty screen", () => {
		for (const text of ["", "\x1b[31m \x1b[0m\n\t\n"]) {
			const value = entry(7, { kind: "running" });
			const selected = { ...value, screen: { ...value.screen, text } };
			const view = describeTerminalsSheet([selected], selected.id);
			const output = onlyNode(view, "section");
			assert.equal(output.key, "output-s7");
			assert.equal(output.p?.head, "Recent output");
			assert.equal(nodesOfKind(output, "code").length, 0);
			assert.equal(nodesOfKind(output, "ansi").length, 0);
			assert.deepEqual(onlyNode(output, "text").p?.spans, [{ t: "No output yet", s: "dim" }]);
		}
	});
});

describe("terminal HUD page description", () => {
	it("frames a full terminal overlay with session id, command, and state in the head", () => {
		for (const state of [{ kind: "running" }, exited(0)] satisfies TerminalState[]) {
			const value = entry(7, state);
			assert.deepEqual(terminalPageFrame(value, value.id), {
				role: "unified-exec.overlay.terminal",
				size: "full",
				head: [
					{ t: "Terminals · ", s: "muted" },
					{ t: "#7 " },
					{ t: value.command, s: "mono" },
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
	nativeSheet?(): boolean;
	readonly nativeOverlay?: Readonly<Record<string, unknown>>;
	handleInput(data: string): void;
	dispose(): void;
}

type StubTui = { requestRender(): void };
type WidgetFactory = (tui: StubTui) => HudComponent;
type WidgetCall = {
	readonly key: string;
	readonly content: WidgetFactory | undefined;
	readonly options: { readonly placement: string } | undefined;
};
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

function makeHarness(t: TestContext, initiallyNative = false) {
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const handlers = new Map<string, Handler[]>();
	const calls: WidgetCall[] = [];
	const customCalls: CustomCall[] = [];
	const customListeners = new Set<() => void>();
	const killCalls: number[] = [];
	const sessions: ExecSession[] = [];
	const nativeListeners = new Set<(on: boolean) => void>();
	let nativeOn = initiallyNative;
	let component: HudComponent | undefined;
	let overlay: CustomComponent | undefined;
	let renders = 0;
	const tui: StubTui = { requestRender: () => { renders++; } };
	const ui = {
		setWidget(key: string, content: WidgetFactory | undefined, options?: { placement: string }) {
			calls.push({ key, content, options });
			// Widget replacement/removal disposes the old component if it owns resources.
			component?.dispose?.();
			component = content?.(tui);
		},
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
	mountTerminalHud(pi, store, native, async (id) => {
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

	return {
		store,
		calls,
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
		get component() {
			assert.ok(component, "terminal HUD is mounted");
			return component;
		},
		get sheet() {
			assert.ok(overlay, "custom overlay is open");
			assert.equal(overlay.nativeSheet?.(), true, "Terminals sheet is open");
			return overlay;
		},
		get page() {
			assert.ok(overlay?.nativeOverlay, "terminal page is open");
			return overlay;
		},
		get mounted() { return component !== undefined; },
		get sheetOpen() { return overlay?.nativeSheet?.() === true; },
		setNative(on: boolean) {
			nativeOn = on;
			for (const listener of nativeListeners) listener(on);
		},
		spawn(command = [process.execPath, "-e", "process.stdin.resume()"], cols = 80, insert = true) {
			const session = ExecSession.spawn(store.allocateId(), {
				command, cwd: process.cwd(), env: process.env, cols, rows: 24,
			});
			sessions.push(session);
			assert.equal(session.failureMessage, null, "child spawn succeeds");
			if (insert) store.insert(session);
			return session;
		},
	};
}

describe("terminal HUD lifecycle with real sessions", () => {
	it("mounts only after UI, native rendering, and a session are all present", async (t) => {
		const h = makeHarness(t);
		h.spawn();
		assert.equal(h.calls.length, 0);
		await h.emit("session_start");
		assert.equal(h.calls.length, 0, "sessions alone do not mount without native rendering");
		h.setNative(true);
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0]?.key, "unified-exec-terminals");
		assert.equal(typeof h.calls[0]?.content, "function");
		assert.deepEqual(h.calls[0]?.options, { placement: "belowEditor" });
		const view = h.component.describe();
		assert.equal(terminalCount(view), 1);
		assert.deepEqual(segmentOf(view).p?.actions, { click: OPEN_ACTION });
	});

	it("waits for an interactive session_start even when native rendering and a session already exist", async (t) => {
		const h = makeHarness(t, true);
		h.spawn();
		assert.equal(h.calls.length, 0);
		await h.emit("session_start", false);
		assert.equal(h.calls.length, 0, "headless session has no widget");
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("keeps mounting until the last stored session is removed", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn();
		const second = h.spawn();
		assert.equal(h.mounted, true);
		h.store.remove(second.id);
		assert.equal(h.store.size, 1);
		assert.equal(h.mounted, true);
		assert.equal(terminalCount(h.component.describe()), 1);
		h.store.remove(first.id);
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		assert.equal(h.calls.at(-1)?.key, "unified-exec-terminals");
	});

	it("unmounts when native rendering stops and remounts when it resumes", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		const first = h.component;
		h.setNative(false);
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		h.setNative(true);
		assert.equal(h.mounted, true);
		assert.notEqual(h.component, first);
	});

	it("unmounts on session_shutdown and stays unmounted until another session starts", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		await h.emit("session_shutdown");
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		const callCount = h.calls.length;
		h.setNative(false);
		h.setNative(true);
		h.spawn();
		assert.equal(h.calls.length, callCount);
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("refreshes the pill count for every stored session", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn();
		const component = h.component;
		const initial = component.describe();
		assert.equal(terminalCount(initial), 1);
		assert.strictEqual(component.describe(), initial);
		h.spawn();
		assert.strictEqual(h.component, component);
		assert.equal(terminalCount(component.describe()), 2);
		h.spawn();
		assert.equal(terminalCount(component.describe()), 3);
		h.store.remove(first.id);
		assert.strictEqual(h.component, component);
		assert.equal(terminalCount(component.describe()), 2);
		assert.equal(segmentOf(component.describe()).p?.title, "2 terminals");
	});

	it("opens exactly one native sheet from the pill and closes, disposes, and reopens it on Close or esc", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn();
		const component = h.component;
		for (const event of [null, {}, { type: "action", act: "unrelated" }, { type: "other", act: OPEN_ACTION }]) {
			component.handleNativeEvent(event);
		}
		assert.equal(h.customCalls.length, 0);
		component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 1);
		assert.deepEqual(h.customCalls[0]?.options, { overlay: true });
		assert.equal(h.sheet.nativeSheet?.(), true);
		component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 1, "a second click while open does nothing");
		const first = h.customCalls[0]!;
		const disposed = t.mock.method(first.component, "dispose");
		h.sheet.handleNativeEvent({ type: "action", act: CLOSE_ACTION });
		await first.promise;
		assert.equal(h.sheetOpen, false);
		assert.equal(first.disposed, true);
		assert.equal(disposed.mock.callCount(), 1);
		component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.customCalls.length, 2, "settling the custom promise allows another sheet");
		const second = h.customCalls[1]!;
		assert.notEqual(second.component, first.component);
		const escaped = t.mock.method(second.component, "dispose");
		h.sheet.handleInput("\x1b");
		await second.promise;
		assert.equal(h.sheetOpen, false);
		assert.equal(second.disposed, true);
		assert.equal(escaped.mock.callCount(), 1);
		assert.equal(h.mounted, true, "closing the sheet does not dismiss the pill");
		assert.equal(h.calls.length, 1, "sheet interactions reuse the mounted widget");
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
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		const sheet = h.sheet;
		const initial = sheet.describe();
		assert.deepEqual(pickerItems(initial).map((item) => item.id), [`s${first.id}`, `s${second.id}`, `s${third.id}`]);
		assert.equal(initial.p?.selected, `s${first.id}`);
		assert.equal(recentOutputText(initial), "first-screen");
		assert.equal(onlyNode(initial, "section").key, `output-s${first.id}`);
		const facts = onlyNode(initial, "kv").p?.items;
		assert.ok(Array.isArray(facts));
		assert.ok(facts.some((fact: unknown) => {
			assert.ok(typeof fact === "object" && fact !== null && "k" in fact && "v" in fact);
			return fact.k === "PID" && fact.v === String(first.pid);
		}), "preview PID comes from the actual PTY session");
		assertLogRow(initial, first.logPath);
		for (const event of [null, {}, { type: "action", act: "unrelated" }, { type: "select", item: "invalid" }]) {
			sheet.handleNativeEvent(event);
		}
		assert.strictEqual(sheet.describe(), initial, "malformed and unrelated events leave the sheet unchanged");
		const before = h.renders;
		sheet.handleNativeEvent({ type: "select", item: `s${second.id}` });
		const selected = sheet.describe();
		assert.ok(h.renders > before);
		assert.equal(selected.p?.selected, `s${second.id}`);
		assert.equal(onlyNode(selected, "section").key, `output-s${second.id}`);
		assert.equal(recentOutputText(selected), "second-screen");
		assert.equal(recentOutputText(selected).includes("\x1b["), false, "real PTY SGR is stripped from the sheet's recent output");
		sheet.handleInput("\x1b[A");
		assert.equal(sheet.describe().p?.selected, `s${first.id}`);
		assert.equal(recentOutputText(sheet.describe()), "first-screen");
		sheet.handleInput("\x1b[B");
		assert.equal(sheet.describe().p?.selected, `s${second.id}`);
		assert.equal(onlyNode(sheet.describe(), "section").key, `output-s${second.id}`);
		assert.equal(recentOutputText(sheet.describe()), "second-screen");
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
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		const sheet = h.sheet;
		const initial = sheet.describe();
		assert.deepEqual(pickerItems(initial), [{ id: `s${session.id}`, dot: "accent" }]);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("exit\r")), true);
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "real child exits on stdin");
		const exitedView = sheet.describe();
		assert.ok(h.renders > before);
		assert.notStrictEqual(exitedView, initial);
		assert.deepEqual(pickerItems(exitedView), [{ id: `s${session.id}`, dot: "success" }]);
		assert.equal(exitedView.p?.subtitle, "0 running · 1 stored");
		assert.equal(h.mounted, true);
		assert.equal(terminalCount(h.component.describe()), 1, "exited sessions remain in the pill count");
	});

	it("never reads a released removed session when describing the remaining pill or sheet", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const removed = h.spawn();
		const remaining = h.spawn();
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		assert.equal(h.sheet.describe().p?.selected, `s${removed.id}`);
		removed.terminate();
		h.store.remove(removed.id);
		await removed.release();
		const forbiddenRead = t.mock.method(removed, "styledScreen", () => { throw new Error("removed screen read after release"); });
		assert.equal(terminalCount(h.component.describe()), 1);
		assert.equal(h.sheet.describe().p?.selected, `s${remaining.id}`);
		h.component.invalidate();
		h.sheet.invalidate();
		assert.doesNotThrow(() => h.component.describe());
		assert.doesNotThrow(() => h.sheet.describe());
		assert.equal(forbiddenRead.mock.callCount(), 0);
	});

	for (const [openWith, backWith] of [["activate", "esc"], ["enter", "back"], ["open", "close"]] as const) {
		it(`opens a terminal page with ${openWith} and returns with ${backWith} to the same selected session`, async (t) => {
			const h = makeHarness(t, true);
			await h.emit("session_start");
			h.spawn();
			const selected = h.spawn();
			h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
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
			assert.equal(frame?.role, "unified-exec.overlay.terminal");
			assert.equal(frame?.size, "full");
			const head = frame?.head;
			assert.ok(Array.isArray(head));
			const headText = head.map((span: unknown) => {
				assert.ok(typeof span === "object" && span !== null && "t" in span && typeof span.t === "string");
				return span.t;
			}).join("");
			assert.ok(headText.includes(`#${selected.id}`));
			assert.ok(headText.includes("process.stdin.resume()"));
			assert.ok(headText.includes("running"));
			const view = page.describe();
			assert.equal(onlyNode(view, "ansi").key, `page-s${selected.id}`);
			assert.equal(onlyNode(view, "ansi").p?.follow, true);
			assert.equal(ansiText(view), selected.styledScreen()?.text);
			assert.deepEqual(nodesOfKind(view, "row").filter((node) => node.p?.role === "omp.btn").map((node) => node.p?.actions),
				[{ click: KILL_ACTION }, { click: BACK_ACTION }]);
			h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
			assert.equal(h.customCalls.length, 2, "a pill click cannot open another sheet over the page");
			if (backWith === "esc") page.handleInput("\x1b");
			else page.handleNativeEvent({ type: "action", act: backWith === "back" ? BACK_ACTION : CLOSE_ACTION });
			assert.equal(await pageCall.promise, undefined);
			await h.waitForCustom(3);
			assert.equal(pageCall.disposed, true);
			assert.equal(h.sheet.describe().p?.selected, `s${selected.id}`);
			assert.equal(selected.hasExited, false, "page navigation does not kill its session");
		});
	}

	it("kills only running selected sessions through the sheet Kill action and x key", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const finished = h.spawn([process.execPath, "-e", "process.exit(0)"]);
		await waitFor(() => finished.hasExited, (listener) => finished.onExit(listener), "finished session exits");
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
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
			assert.equal(h.sheet.describe().p?.selected, `s${finished.id}`);
		}
		assert.equal(h.killCalls.length, 2);
		assert.ok(h.store.get(finished.id), "the finished session remains stored");
	});

	it("writes printable page input to a real cat terminal while Esc returns without being written", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(["/bin/sh", "-c", "stty -echo; printf 'cat-ready\\n'; exec cat"]);
		await waitFor(() => session.styledScreen()?.text.includes("cat-ready") === true,
			(listener) => session.onScreenChange(listener), "cat terminal is ready with echo disabled");
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
		h.sheet.handleInput("\r");
		await h.waitForCustom(2);
		const page = h.page;
		const writes = t.mock.method(session, "write");
		page.handleInput("typed-through-page\r");
		await waitFor(() => session.styledScreen()?.text.includes("typed-through-page") === true,
			(listener) => session.onScreenChange(listener), "cat emits the page's typed line");
		assert.match(ansiText(page.describe()), /typed-through-page/);
		assert.equal(writes.mock.callCount(), 1);
		assert.equal(Buffer.from(writes.mock.calls[0]!.arguments[0]!).toString(), "typed-through-page\r");
		const pageCall = h.customCalls[1]!;
		page.handleInput("\x1b");
		await pageCall.promise;
		await h.waitForCustom(3);
		assert.equal(writes.mock.callCount(), 1, "Esc is navigation, not terminal input");
		assert.equal(pageCall.disposed, true);
		assert.equal(h.sheet.describe().p?.selected, `s${session.id}`);
		assert.equal(session.hasExited, false);
	});

	it("stops forwarding page input after its real child exits and removes the Kill button", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0))"]);
		await waitFor(() => session.styledScreen()?.text.includes("ready") === true,
			(listener) => session.onScreenChange(listener), "page child is ready");
		h.component.handleNativeEvent({ type: "action", act: OPEN_ACTION });
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
		const pill = h.component;
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
		assert.equal(h.sheet.describe().p?.selected, null);
		assert.deepEqual(h.sheet.describe().p?.items, []);
	});
});
