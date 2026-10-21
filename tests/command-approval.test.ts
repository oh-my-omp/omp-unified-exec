import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	approveCommand, getBashApprovalPatternRules, type ApprovalHelpers, type BashApprovalPatternRule,
	type CommandApproval, type CommandApprovalHost,
} from "../fork-features/command-approval.ts";
import { bindSession, bindingContext, recheckBinding, type BoundSession } from "../fork-features/session-binding.ts";
import { activate } from "../src/index.ts";

// Canned literal segments exercise the port's branches, not shell parsing or
// builtin parity. Real tokenizer and builtin comparisons run in real omp.
const helpers: ApprovalHelpers = {
	criticalPatterns: [/rm -rf/],
	tokenizeShellSegments(command) {
		assert.ok(["true", "echo x", "rm -rf /", "ls"].includes(command), command);
		return [command.split(" ")];
	},
	extractLiteralAndChainSegments(command) {
		assert.equal(command, "true && echo x");
		return [{ text: "true", argv: ["true"] }, { text: "echo x", argv: ["echo", "x"] }];
	},
	truncateForPrompt: (command) => command.slice(0, 40),
};

interface RegisteredTool {
	readonly name: string;
	readonly approval?: (args: unknown) => CommandApproval;
	readonly formatApprovalDetails?: (args: unknown) => string[];
}

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function harness(host: CommandApprovalHost) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		on(name: string, handler: EventHandler) {
			const listeners = handlers.get(name) ?? [];
			listeners.push(handler);
			handlers.set(name, listeners);
		},
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {}, getFlag() { return false; },
	} as unknown as ExtensionAPI;
	activate(api, undefined, undefined, host);
	const tool = tools.get("exec_command")!;
	assert.ok(tool.approval);
	assert.ok(tool.formatApprovalDetails);
	return {
		tool, tools,
		async emit(name: string, sessionManager: unknown, id = "main") {
			for (const handler of handlers.get(name) ?? []) {
				await handler({}, { agent: { id }, sessionManager, ui: { setStatus() {}, setWidget() {} } });
			}
		},
	};
}

describe("command approval port", () => {
	it("filters malformed rules and preserves order and normalization", () => {
		assert.deepEqual(getBashApprovalPatternRules([null, [], {}, { match: " ", approval: "deny" },
			{ match: "true", approval: "invalid" }, { match: " true  ", approval: " ALLOW " },
			{ match: "true", approval: "deny" }]), [
			{ match: "true", approval: "allow" }, { match: "true", approval: "deny" },
		]);
		assert.deepEqual(getBashApprovalPatternRules(undefined), []);
	});

	it("keeps first-match semantics rather than strictest-rule sorting", () => {
		for (const first of ["allow", "prompt", "deny"] as const) {
			const decision = approveCommand("true", [{ match: "true", approval: first }, { match: "*", approval: "deny" }], undefined, helpers);
			assert.equal(typeof decision === "object" && "policy" in decision ? decision.policy : decision, first);
		}
	});

	it("does not carry a standalone allow across shell control", () => {
		const literalHelpers = { ...helpers, tokenizeShellSegments: () => [["true"], ["echo", "x"]] };
		assert.equal(approveCommand("true && echo x", [{ match: "true", approval: "allow" }], undefined, literalHelpers), "exec");
	});

	it("aggregates whole-chain restrictions while preserving segment first matches", () => {
		const rules: BashApprovalPatternRule[] = [
			{ match: "true && echo x", approval: "prompt" },
			{ match: "true && echo x", approval: "deny" },
			{ match: "true", approval: "allow" }, { match: "echo x", approval: "allow" },
		];
		assert.deepEqual(approveCommand("true && echo x", rules, "/bin/zsh", helpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: true && echo x",
		});
		assert.equal(approveCommand("true && echo x", rules.slice(2, 3), "/bin/zsh", helpers), "exec");
		assert.deepEqual(approveCommand("true && echo x", rules.slice(2), "/bin/zsh", helpers), { tier: "write", policy: "allow" });
		assert.deepEqual(approveCommand("true && echo x", [rules[0], ...rules.slice(2)], "/bin/zsh", helpers), {
			tier: "exec", override: true, policy: "prompt", reason: "Prompt required by bash pattern: true && echo x",
		});
		assert.deepEqual(approveCommand("true && echo x", [...rules.slice(2), { match: "true", approval: "deny" }], "/bin/zsh", helpers), { tier: "write", policy: "allow" });
	});

	it("preserves deny and critical precedence", () => {
		assert.deepEqual(approveCommand("rm -rf /", [{ match: "*", approval: "deny" }], undefined, helpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: *",
		});
		assert.deepEqual(approveCommand("rm -rf /", [{ match: "*", approval: "prompt" }], undefined, helpers), {
			tier: "exec", override: true, reason: "Critical pattern detected",
		});
	});
});

describe("approval session binding via activate", () => {
	it("pending and Unbound do not read settings, including dangerous commands", async () => {
		const host: CommandApprovalHost = {
			registeredSession: () => undefined,
			approvalRules() { throw new Error("must not read rules"); },
			allowCompoundCommands() { throw new Error("must not read compound setting"); }, helpers,
		};
		const h = harness(host);
		for (const phase of ["pending", "unbound"]) {
			assert.equal(h.tool.approval!({ cmd: "rm -rf /" }), "exec", phase);
			assert.equal(h.tool.approval!({ cmd: "true" }), "exec", phase);
			await h.emit("session_start", {});
		}
		for (const tool of h.tools.values()) if (tool.name !== "exec_command") {
			assert.equal(tool.approval, undefined, tool.name);
			assert.equal(tool.formatApprovalDetails, undefined, tool.name);
		}
		assert.deepEqual(h.tool.formatApprovalDetails!({ cmd: "rm -rf /definitely-not-here-uexec" }), ["Command: rm -rf /definitely-not-here-uexec"]);
		assert.deepEqual(h.tool.formatApprovalDetails!({}), ["Command: (missing)"]);
	});

	it("binds once, reads live settings, and only rechecks identity on switches/branches", async () => {
		const manager = {};
		const initial = { getShellConfig() { throw new Error("compound disabled: no shell read"); } };
		const replacement = { getShellConfig() { return { shell: "/bin/zsh" }; } };
		const session: BoundSession = { settings: initial, sessionManager: manager };
		let lookups = 0;
		let rules: BashApprovalPatternRule[] = [{ match: "true", approval: "allow" }];
		let lastSettings: unknown;
		const h = harness({
			registeredSession(id) { assert.equal(id, "main"); lookups++; return { session }; },
			approvalRules(settings) { lastSettings = settings; return rules; },
			allowCompoundCommands: () => false, helpers,
		});
		await h.emit("session_start", manager);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "write", policy: "allow" });
		assert.equal(lastSettings, initial);
		rules = [{ match: "true", approval: "deny" }];
		Object.assign(session, { settings: replacement });
		await h.emit("session_switch", manager);
		await h.emit("session_branch", manager);
		await h.emit("session_start", manager);
		assert.equal(lookups, 1);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: true" });
		assert.equal(lastSettings, replacement);
		await h.emit("session_branch", {});
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		await h.emit("session_switch", manager);
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		assert.equal(lookups, 1);
	});

	it("rejects missing entries and mismatched managers without reading settings", () => {
		const manager = {};
		const session = { sessionManager: manager, get settings() { throw new Error("must not read settings during bind"); } };
		const host = { registeredSession: () => ({ session }) };
		assert.deepEqual(bindSession(host, { agentId: undefined, sessionManager: manager }), { kind: "unbound", reason: "no-registry-entry" });
		assert.deepEqual(bindSession(host, { agentId: "main", sessionManager: {} }), { kind: "unbound", reason: "identity-mismatch" });
		const pending = { kind: "pending" } as const;
		assert.equal(recheckBinding(pending, { agentId: "main", sessionManager: manager }), pending);
		assert.deepEqual(bindingContext({ agent: { id: "main" }, sessionManager: manager }), { agentId: "main", sessionManager: manager });
	});
});
