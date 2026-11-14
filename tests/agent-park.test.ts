/**
 * A subagent's terminals across omp's idle park, through the real tools and
 * real PTYs. omp's agent registry and lifecycle are simulated by `FakeOmp`
 * with omp's observable contract: `isParking` is true during the park's
 * `session_shutdown`, `revive` resolves after the revived activation saw
 * `session_start`, and a released generation ends through the registry.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { type AgentGeneration, type AgentHost, type AgentIdentity, parkedRuntimes, parseAgentHost } from "../fork-features/agent-park.ts";
import { activate } from "../src/index.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

const MINUTE = 60_000;
const AGENT = "0-Worker";

interface ListedSession { session_id: number; pid?: number; running: boolean }
interface ToolResult { details: { session_id?: number; killed?: boolean; sessions?: ListedSession[] } }
interface ToolDef {
	name: string;
	execute: (toolCallId: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<ToolResult>;
}
interface Sent { message: { details: { notices: Array<{ session_id: number; kind: string }> } } }
type Handler = (event: object, ctx: object) => unknown;

class FakeOmp implements AgentHost {
	generation = {} as AgentGeneration;
	adopted = false;
	parking = false;
	revives = 0;
	reviver: (() => Promise<void>) | undefined;
	private readonly ended = new Set<(generation: AgentGeneration) => void>();

	identify(agentId: string): AgentIdentity | undefined {
		return agentId === AGENT ? { agentId, generation: this.generation } : undefined;
	}
	isParking(agent: AgentIdentity): boolean {
		return this.parking && agent.generation === this.generation;
	}
	isAdopted(agent: AgentIdentity): boolean {
		return this.adopted && agent.generation === this.generation;
	}
	async revive(): Promise<void> {
		this.revives++;
		assert.ok(this.reviver, "a revive was expected");
		await this.reviver();
	}
	onEnded(listener: (generation: AgentGeneration) => void): () => void {
		this.ended.add(listener);
		return () => this.ended.delete(listener);
	}
	/** omp releases the current generation (a main session's teardown, or a kill). */
	release(): void {
		for (const listener of this.ended) listener(this.generation);
	}
	/** A new agent generation for the next test. */
	reset(): void {
		this.release();
		this.generation = {} as AgentGeneration;
		this.adopted = false;
		this.parking = false;
		this.revives = 0;
		this.reviver = undefined;
	}
}

// One per process, as omp's registry is: the parked-runtime listener subscribes once.
const omp = new FakeOmp();

interface Harness {
	readonly sent: Sent[];
	emit(event: string): Promise<void>;
	call(name: string, params: object): Promise<ToolResult>;
	advance(ms: number): void;
	listed(id: number): Promise<ListedSession | undefined>;
}

const live = new Set<Harness>();

function makeHarness(): Harness {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const sent: Sent[] = [];
	let now = Date.now();
	let sweep: (() => void) | undefined;
	const stubCtx = { cwd: process.cwd(), ui: { notify() {}, setStatus() {}, setWidget() {} }, hasUI: false, agent: { id: AGENT } };
	const pi = {
		registerTool: (def: ToolDef) => { tools[def.name] = def; },
		on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		getFlag: () => false, getActiveTools: () => ["bash"], setActiveTools() {},
		sendMessage: (message: Sent["message"]) => { sent.push({ message }); },
	};
	activate(pi as unknown as Parameters<typeof activate>[0], undefined, undefined, undefined, undefined, {
		nowFn: () => now,
		setIntervalFn: (cb) => { sweep = cb; return 1; },
		clearIntervalFn: () => { sweep = undefined; },
	}, undefined, undefined, omp, stubShellHost);
	let nextCallId = 1;
	const harness: Harness = {
		sent,
		async emit(event) {
			for (const h of handlers[event] ?? []) await h({}, stubCtx);
		},
		async call(name, params) {
			const toolCallId = `call-${nextCallId++}`;
			const result = await tools[name]!.execute(toolCallId, params, undefined, undefined, stubCtx);
			await harness.emit("tool_execution_end");
			return result;
		},
		advance(ms) {
			now += ms;
			sweep?.();
		},
		async listed(id) {
			return (await harness.call("list_sessions", {})).details.sessions?.find((s) => s.session_id === id);
		},
	};
	live.add(harness);
	return harness;
}

afterEach(async () => {
	omp.parking = false;
	for (const h of live) await h.emit("session_shutdown");
	live.clear();
	omp.reset();
	await parkedRuntimes().settled();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

/** Lets a notice that should NOT be sent pass its 250 ms merge window. */
const settle = () => new Promise((r) => setTimeout(r, 400));

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startBackground(h: Harness, cmd: string, extra: object = {}): Promise<{ sid: number; pid: number }> {
	const started = await h.call("exec_command", { cmd, title: "job", shell: "/bin/sh", yield_time_ms: 250, ...extra });
	const sid = started.details.session_id;
	assert.ok(sid !== undefined, JSON.stringify(started.details));
	const pid = (await h.listed(sid))?.pid;
	assert.ok(pid !== undefined);
	return { sid, pid };
}

/** omp adopts the finished subagent, then parks it after its idle TTL. */
async function park(h: Harness): Promise<void> {
	omp.adopted = true;
	omp.parking = true;
	await h.emit("session_shutdown");
	omp.parking = false;
}

/** omp revives the agent: a new activation sees session_start. */
async function revive(): Promise<Harness> {
	const revived = makeHarness();
	await revived.emit("session_start");
	return revived;
}

describe("a subagent's terminals across omp's park", { skip: process.platform === "win32" }, () => {
	it("survive the park, and the revived agent drives them by their session ids", async () => {
		const first = makeHarness();
		await first.emit("session_start");
		const { sid, pid } = await startBackground(first, "sleep 300");
		await park(first);
		await settle();
		assert.ok(alive(pid), "the park killed nothing");
		const revived = await revive();
		assert.equal((await revived.listed(sid))?.running, true);
		const killed = await revived.call("kill_session", { session_id: sid });
		assert.equal(killed.details.killed, true);
		assert.equal(alive(pid), false);
		assert.equal(first.sent.length + revived.sent.length, 0);
	});

	it("a normal exit never revives a parked agent, even with on_exit wake; an unread terminal is reclaimed silently at its TTL", async () => {
		const first = makeHarness();
		await first.emit("session_start");
		const { sid } = await startBackground(first, "sleep 0.5", { on_exit: "wake" });
		await park(first);
		await waitFor(async () => (await first.listed(sid))?.running === false);
		await settle();
		first.advance(30 * MINUTE);
		assert.ok(await waitFor(async () => (await first.listed(sid)) === undefined), "reclaimed at its TTL");
		await settle();
		assert.equal(omp.revives, 0);
		assert.equal(first.sent.length, 0, "neither exit_wake, unread nor reclaimed went out");
	});

	it("an abnormal return revives the parked agent and reaches it through the revived activation", async () => {
		const first = makeHarness();
		await first.emit("session_start");
		const { sid } = await startBackground(first, "sleep 1; exit 3");
		await park(first);
		let revived: Harness | undefined;
		omp.reviver = async () => { revived = await revive(); };
		assert.ok(await waitFor(() => (revived?.sent.length ?? 0) > 0), "the problem reached the revived agent");
		assert.equal(omp.revives, 1);
		assert.deepEqual(revived!.sent[0].message.details.notices.map((n) => [n.session_id, n.kind]), [[sid, "abnormal_return"]]);
		assert.equal(first.sent.length, 0, "nothing went to the parked activation");
	});

	it("end when omp releases the parked agent", async () => {
		const first = makeHarness();
		await first.emit("session_start");
		const { pid } = await startBackground(first, "trap '' TERM; sleep 300");
		await park(first);
		assert.equal(parkedRuntimes().size, 1);
		omp.release();
		await parkedRuntimes().settled();
		assert.equal(alive(pid), false, "the release killed it, escalating past SIGTERM");
		assert.equal(parkedRuntimes().size, 0);
	});

	it("an idle adopted agent gets no turn from a normal exit wake, and one from an abnormal return", async () => {
		const first = makeHarness();
		await first.emit("session_start");
		omp.adopted = true;
		const quiet = await startBackground(first, "sleep 0.3", { on_exit: "wake" });
		await waitFor(async () => (await first.listed(quiet.sid))?.running === false);
		await settle();
		assert.equal(first.sent.length, 0);
		const problem = await startBackground(first, "sleep 0.3; exit 3");
		assert.ok(await waitFor(() => first.sent.length > 0), "the abnormal return woke the agent");
		assert.deepEqual(first.sent[0].message.details.notices.map((n) => [n.session_id, n.kind]), [[problem.sid, "abnormal_return"]]);
	});
});

describe("omp's agent registry and lifecycle exports", () => {
	it("are read as omp exports them: classes with a static global()", async () => {
		type Event = { type: string; ref: object };
		const ref = { status: "idle" };
		const listeners = new Set<(event: Event) => void>();
		const calls: string[] = [];
		class AgentRegistry {
			static global() { return new AgentRegistry(); }
			get(id: string) { return id === AGENT ? ref : undefined; }
			onChange(listener: (event: Event) => void) { listeners.add(listener); return () => listeners.delete(listener); }
		}
		class AgentLifecycleManager {
			static global() { return new AgentLifecycleManager(); }
			isParking(id: string, expected: object) { return id === AGENT && expected === ref; }
			has() { return false; }
			async ensureLive(id: string) { calls.push(id); }
		}
		const host = parseAgentHost({ AgentRegistry }, { AgentLifecycleManager });
		const agent = host.identify(AGENT);
		assert.ok(agent);
		assert.equal(host.identify("other"), undefined);
		assert.equal(host.isParking(agent), true);
		assert.equal(host.isAdopted(agent), false);
		await host.revive(AGENT);
		assert.deepEqual(calls, [AGENT]);
		const ended: object[] = [];
		const unsubscribe = host.onEnded((generation) => ended.push(generation));
		for (const listener of listeners) {
			listener({ type: "status_changed", ref: { status: "parked" } });
			listener({ type: "status_changed", ref: { status: "aborted" } });
			listener({ type: "removed", ref });
		}
		assert.equal(ended.length, 2, "aborted and removed end a generation; parked does not");
		assert.strictEqual(ended[1], ref);
		unsubscribe();
		assert.equal(listeners.size, 0);
		assert.throws(() => parseAgentHost({ AgentRegistry }, { AgentLifecycleManager: class { static global() { return {}; } } }), /AgentLifecycleManager lacks isParking\(\)/);
	});
});
