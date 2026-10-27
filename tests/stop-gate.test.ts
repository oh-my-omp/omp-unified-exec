import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_STOP_CONFIG, fillTemplate, parseStopSection, type StopConfig } from "../fork-features/stop-config.ts";
import { parseLlmAnswer, parseTodoRead, todoVerdict } from "../fork-features/stop-gate.ts";
import {
	NoticeDispatcher,
	type NoticeGate,
	type NoticeMessage,
	type NoticeOutcome,
	type StopInput,
	type StopVerdict,
	type TerminalNotice,
} from "../fork-features/terminal-notice.ts";

function notice(sessionId: number, body: TerminalNotice["body"]): TerminalNotice {
	return { identity: { sessionId, title: `t${sessionId}`, terminalUrl: undefined, logPath: undefined }, body };
}
const unread = (sessionId: number) => notice(sessionId, { kind: "unread", outcome: { kind: "normal" }, returnedAgoMs: 1_800_000 });
const match = (sessionId: number) => notice(sessionId, {
	kind: "monitor_match", monitor: { condition: "x", returns: 1, maxReturns: 10, remindAfterMs: 1_200_000 }, lines: ["x"], omitted: 0, recentMatches: 1,
});

interface Harness {
	readonly notices: NoticeDispatcher;
	readonly sent: NoticeMessage[];
	readonly inputs: StopInput[];
	collects: number;
	/** Terminals the lifecycle still owns; collect() untracks `returned`. */
	readonly tracked: Set<number>;
	readonly returned: Set<number>;
	resolveDetect(verdict: StopVerdict): void;
}

/** A dispatcher whose timer never fires on its own: flushes happen only at the run events under test. */
function harness(config: StopConfig = DEFAULT_STOP_CONFIG): Harness {
	let resolve: ((verdict: StopVerdict) => void) | undefined;
	const h: Harness = {
		sent: [], inputs: [], collects: 0, tracked: new Set(), returned: new Set(),
		resolveDetect: (verdict) => {
			assert.ok(resolve, "no decision in progress");
			resolve(verdict);
		},
		notices: undefined as unknown as NoticeDispatcher,
	};
	const gate: NoticeGate = {
		config: () => config,
		detect: (_config, input) => {
			h.inputs.push(input);
			const pending = Promise.withResolvers<StopVerdict>();
			resolve = pending.resolve;
			return pending.promise;
		},
		collect: async () => {
			h.collects++;
			for (const id of h.returned) h.tracked.delete(id);
		},
		tracked: (id) => h.tracked.has(id),
		verdict: () => {},
	};
	Object.assign(h, { notices: new NoticeDispatcher({ send: (message) => { h.sent.push(message); }, gate, setTimeoutFn: () => 1, clearTimeoutFn: () => {} }) });
	return h;
}

describe("notice delivery around runs", () => {
	it("holds notices while a run is in progress and merges them into one follow-up when it settles", async () => {
		const h = harness();
		h.notices.agentStarted();
		void h.notices.submit(match(1));
		void h.notices.submit(match(2));
		h.notices.flush();
		assert.equal(h.sent.length, 0);
		h.notices.agentStopped("final");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].details.notices.length, 2);
	});

	it("keeps holding across agent_end that omp continues, and never decides a wait for background work", async () => {
		const h = harness();
		h.notices.agentStarted();
		h.notices.recordResponse("waiting for the subagent");
		void h.notices.submit(unread(1));
		h.notices.agentStopped("awaiting");
		assert.equal(h.inputs.length, 0, "no decision while awaiting background work");
		assert.equal(h.sent.length, 1);
	});

	it("a done verdict reclaims returned terminals once and drops only their notices", async () => {
		const h = harness();
		h.tracked.add(1).add(2);
		h.returned.add(1);
		h.notices.agentStarted();
		h.notices.recordResponse("All done and pushed.");
		const dropped = h.notices.submit(unread(1));
		const delivered = h.notices.submit(match(2));
		h.notices.agentStopped("final");
		assert.equal(h.sent.length, 0, "nothing is sent before the decision");
		assert.equal(h.inputs[0].lastResponse, "All done and pushed.");
		h.resolveDetect({ kind: "done", detector: "judge" });
		assert.equal(await dropped, "dropped" satisfies NoticeOutcome);
		assert.equal(await delivered, "delivered");
		assert.equal(h.collects, 1);
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.sent[0].details.notices.map((n) => n.session_id), [2]);
		// One decision per stop: a later notice in the same stop is delivered without another.
		h.returned.add(2);
		void h.notices.submit(unread(2));
		h.notices.flush();
		assert.equal(h.inputs.length, 1);
		assert.equal(h.collects, 1);
		assert.equal(h.sent.length, 2);
	});

	it("not_done and undecided deliver everything without reclaiming", async () => {
		for (const verdict of [{ kind: "not_done", detector: "llm" }, { kind: "undecided", cause: "failed", reason: "x" }] as const) {
			const h = harness();
			h.tracked.add(1);
			h.returned.add(1);
			h.notices.agentStarted();
			h.notices.recordResponse("next I will run the tests");
			const delivered = h.notices.submit(unread(1));
			h.notices.agentStopped("final");
			h.resolveDetect(verdict);
			assert.equal(await delivered, "delivered");
			assert.equal(h.collects, 0);
			assert.equal(h.sent.length, 1);
		}
	});

	it("a run starting during the decision discards its verdict; the notices wait for the next stop", async () => {
		const h = harness();
		h.tracked.add(1);
		h.returned.add(1);
		h.notices.agentStarted();
		h.notices.recordResponse("Done.");
		const delivered = h.notices.submit(unread(1));
		h.notices.agentStopped("final");
		h.notices.agentStarted();
		h.resolveDetect({ kind: "done", detector: "judge" });
		h.notices.recordResponse("Still working.");
		h.notices.agentStopped("final");
		assert.equal(h.inputs.at(-1)?.lastResponse, "Still working.");
		h.resolveDetect({ kind: "not_done", detector: "judge" });
		assert.equal(await delivered, "delivered");
		assert.equal(h.collects, 0, "the discarded done verdict reclaimed nothing");
	});

	it("stop: off drops lifecycle notices only and decides nothing", async () => {
		const h = harness({ ...DEFAULT_STOP_CONFIG, mode: "off" });
		h.notices.agentStarted();
		h.notices.recordResponse("Done.");
		const lifecycle = h.notices.submit(unread(1));
		void h.notices.submit(match(2));
		h.notices.agentStopped("final");
		assert.equal(await lifecycle, "dropped");
		assert.equal(h.inputs.length, 0);
		assert.deepEqual(h.sent[0].details.notices.map((n) => n.kind), ["monitor_match"]);
	});

	it("the configured template shapes the injected text", () => {
		const h = harness({ ...DEFAULT_STOP_CONFIG, noticeTemplate: "{notice_count} for {terminal_count}: {instruction}" });
		void h.notices.submit(match(1));
		h.notices.flush();
		assert.match(h.sent[0].content, /^1 for 1: Do not reply to the user/);
	});
});

describe("stop configuration", () => {
	it("rejects unknown keys, modes and placeholders", () => {
		assert.equal(parseStopSection({ stop: "always" }).kind, "error");
		assert.equal(parseStopSection({ mode: "auto" }).kind, "error");
		assert.equal(parseStopSection({ judgePrompt: "{last_respons}" }).kind, "error");
		assert.equal(parseStopSection({ noticeTemplate: "{last_response}" }).kind, "error");
		const ok = parseStopSection({ stop: "todo", judgePrompt: 'Reply: {last_response} as { "done": true }' });
		assert.deepEqual(ok, { kind: "ok", config: { ...DEFAULT_STOP_CONFIG, mode: "todo", judgePrompt: 'Reply: {last_response} as { "done": true }' } });
	});

	it("substitutes in one pass, so an inserted value is never expanded", () => {
		assert.equal(fillTemplate("{a}/{b}", { a: "{b}", b: "x" }), "{b}/x");
	});
});

describe("stop detectors", () => {
	const read = (counts: Record<string, number>) => parseTodoRead({ kind: "ok", goal: null, openItems: [], counts });
	const zero = { pending: 0, in_progress: 0, completed: 0, abandoned: 0, blocked: 0 };

	it("todo: done only when every item is completed or abandoned", () => {
		assert.deepEqual(todoVerdict(read({ ...zero, completed: 2, abandoned: 1 })), { kind: "done", detector: "todo" });
		assert.deepEqual(todoVerdict(read({ ...zero, completed: 2, blocked: 1 })), { kind: "not_done", detector: "todo" });
		assert.equal(todoVerdict(read(zero)).kind, "undecided");
		assert.equal(todoVerdict(parseTodoRead({ kind: "ok", goal: null, openItems: [] })).kind, "undecided", "a reply without counts");
		assert.equal(todoVerdict(parseTodoRead(undefined)).kind, "undecided");
	});

	it("llm: reads DONE / NOT_DONE from the first line only", () => {
		assert.equal(parseLlmAnswer("**DONE**\nall pushed"), "done");
		assert.equal(parseLlmAnswer("NOT_DONE\nDONE"), "not_done");
		assert.equal(parseLlmAnswer("It is done."), undefined);
	});
});
