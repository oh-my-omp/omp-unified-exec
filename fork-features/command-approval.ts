/**
 * Command approval copied from can1357/oh-my-pi@57b56631ee009098a78d9badf91afc3a48eef32e,
 * packages/coding-agent/src/tools/bash.ts (approval helpers and BashTool.approval).
 * Differences: the command is exec_command's raw `cmd`; settings are parsed at
 * the bound-session adapter; host tokenizer/critical patterns are injected.
 * The unavailable utils/procmgr `isPosixShell` predicate is copied verbatim.
 */
import type { HostBindingState, HostSettings, SessionRegistry } from "./session-binding.ts";

export type BashPatternApproval = "allow" | "deny" | "prompt";
export interface BashApprovalPatternRule {
	readonly match: string;
	readonly approval: BashPatternApproval;
}
export type CommandApproval =
	| "exec"
	| { readonly tier: "write"; readonly policy: "allow" }
	| { readonly tier: "exec"; readonly override: true; readonly reason: "Critical pattern detected" }
	| { readonly tier: "exec"; readonly override: true; readonly policy: "deny" | "prompt"; readonly reason: string };

export interface LiteralShellCommandSegment {
	readonly text: string;
	readonly argv: readonly string[];
}
export interface ApprovalHelpers {
	readonly criticalPatterns: readonly RegExp[];
	readonly tokenizeShellSegments: (command: string) => readonly (readonly string[])[];
	readonly extractLiteralAndChainSegments: (command: string) => readonly LiteralShellCommandSegment[] | null;
	readonly truncateForPrompt: (command: string) => string;
}

type Tokenize = ApprovalHelpers["tokenizeShellSegments"];
const BASH_APPROVAL_SHELL_CONTROL_CHARS: Readonly<Record<string, true>> = {
	"\n": true, "\r": true, ";": true, "&": true, "|": true, "<": true,
	">": true, "`": true, $: true, "(": true, ")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) hasReinterpretableShellControl = true;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') { quote = undefined; continue; }
			if (ch === "`" || ch === "$") return true;
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}
function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern).split("*")
		.map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&")).join(".*");
	return new RegExp(`^${escaped}$`, "u");
}
function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "allow" || normalized === "deny" || normalized === "prompt" ? normalized : undefined;
}

/** Parse the host setting once at this call's boundary, including upstream's invalid-rule filtering. */
export function getBashApprovalPatternRules(value: unknown): readonly BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	const items: readonly unknown[] = value;
	return items.map((item): BashApprovalPatternRule | undefined => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
		if (!("match" in item) || typeof item.match !== "string" || !("approval" in item)) return undefined;
		const match = normalizeBashApprovalPattern(item.match);
		const approval = normalizeBashPatternApproval(item.approval);
		return match.length > 0 && approval ? { match, approval } : undefined;
	}).filter((rule): rule is BashApprovalPatternRule => rule !== undefined);
}
function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalized = normalizeBashApprovalPattern(command);
	return normalized.length > 0 && bashApprovalPatternToRegExp(pattern).test(normalized);
}
function bashCommandSegments(command: string, tokenize: Tokenize): string[] {
	return tokenize(command).map((segment) => segment.join(" ")).filter((segment) => segment.length > 0);
}
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string, tokenize: Tokenize): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalized = normalizeBashApprovalPattern(command);
	if (normalized.length === 0) return false;
	if (regex.test(normalized)) return true;
	return bashCommandSegments(command, tokenize).some((segment) => regex.test(segment));
}
function bashApprovalRuleMatches(command: string, rule: BashApprovalPatternRule, tokenize: Tokenize): boolean {
	if (rule.approval === "allow") {
		if (hasBashApprovalShellControl(command)) return false;
		return commandMatchesBashApprovalPattern(command, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match, tokenize);
}
function findBashApprovalPatternRule(command: string, rules: readonly BashApprovalPatternRule[], tokenize: Tokenize): BashApprovalPatternRule | undefined {
	return rules.find((rule) => bashApprovalRuleMatches(command, rule, tokenize));
}

// Copied from packages/utils/src/procmgr.ts: isPosixShell.
const POSIX_SHELL_PATTERN = /(?:^|[\\/])(?:sh|bash|dash|ash|ksh|zsh)(?:\.exe)?$/i;
function isPosixShell(shell: string): boolean {
	return POSIX_SHELL_PATTERN.test(shell);
}

/** Exactly the built-in BashTool approval precedence, with already-bound inputs. */
export function approveCommand(command: string, patternRules: readonly BashApprovalPatternRule[], shell: string | undefined, helpers: ApprovalHelpers): CommandApproval {
	const tokenize = helpers.tokenizeShellSegments;
	const compoundSegments = shell && isPosixShell(shell) ? helpers.extractLiteralAndChainSegments(command) : null;
	let patternRule: BashApprovalPatternRule | undefined;
	if (compoundSegments) {
		for (const rule of patternRules) {
			if (rule.approval !== "allow" && commandMatchesBashApprovalPattern(command, rule.match) &&
				!compoundSegments.some((segment) => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match, tokenize))) {
				if (rule.approval === "deny") { patternRule = rule; break; }
				patternRule ??= rule;
			}
		}
	} else {
		patternRule = findBashApprovalPatternRule(command, patternRules, tokenize);
	}
	if (patternRule?.approval === "deny") {
		return { tier: "exec", override: true, policy: "deny", reason: `Blocked by bash pattern: ${patternRule.match}` };
	}
	const criticalCommand = command !== "" && helpers.criticalPatterns.some((pattern) => pattern.test(command));
	if (!compoundSegments && criticalCommand) return { tier: "exec", override: true, reason: "Critical pattern detected" };
	if (compoundSegments) {
		let promptRule: BashApprovalPatternRule | undefined = patternRule;
		let hasUnmatchedSegment = false;
		for (const segment of compoundSegments) {
			const segmentRule = findBashApprovalPatternRule(segment.text, patternRules, tokenize);
			if (segmentRule?.approval === "deny") {
				return { tier: "exec", override: true, policy: "deny", reason: `Blocked by bash pattern: ${segmentRule.match}` };
			}
			if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
			if (!segmentRule) hasUnmatchedSegment = true;
		}
		if (promptRule) return { tier: "exec", override: true, policy: "prompt", reason: `Prompt required by bash pattern: ${promptRule.match}` };
		for (const segment of compoundSegments) {
			const literalCommand = segment.argv.join(" ");
			if (criticalCommand || helpers.criticalPatterns.some((pattern) => pattern.test(literalCommand))) {
				return { tier: "exec", override: true, reason: "Critical pattern detected" };
			}
		}
		return hasUnmatchedSegment ? "exec" : { tier: "write", policy: "allow" };
	}
	if (patternRule?.approval === "allow") return { tier: "write", policy: "allow" };
	if (patternRule?.approval === "prompt") return { tier: "exec", override: true, policy: "prompt", reason: `Prompt required by bash pattern: ${patternRule.match}` };
	return "exec";
}

/** Parse the raw tool argument; malformed inputs match built-in approval's empty/missing behavior. */
export function approvalCommand(args: unknown, fallback: string): string {
	return typeof args === "object" && args !== null && "cmd" in args && typeof args.cmd === "string" ? args.cmd : fallback;
}

export interface CommandApprovalHost extends SessionRegistry {
	readonly approvalRules: (settings: HostSettings) => readonly BashApprovalPatternRule[];
	readonly allowCompoundCommands: (settings: HostSettings) => boolean;
	readonly helpers: ApprovalHelpers;
}

/** The unbound path must return before touching any session settings. */
export function approveBoundCommand(host: CommandApprovalHost, binding: HostBindingState, args: unknown): CommandApproval {
	if (binding.kind !== "bound") return "exec";
	const settings = binding.session.settings;
	const rules = host.approvalRules(settings);
	const shell = host.allowCompoundCommands(settings) ? settings.getShellConfig().shell : undefined;
	return approveCommand(approvalCommand(args, ""), rules, shell, host.helpers);
}

function property(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

type HostFunction = (...args: never[]) => unknown;

function exportedFunction(module: unknown, name: string, from: string): HostFunction {
	const value = property(module, name);
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}()`);
	return value as HostFunction;
}

function settingReader(module: unknown, name: string): (settings: HostSettings) => unknown {
	const setting = property(module, name);
	const get = property(setting, "get");
	if (typeof get !== "function") throw new Error(`omp-unified-exec: exec/settings lacks ${name}.get()`);
	return (settings) => get.call(setting, settings);
}

/** Factory-only imports: missing host contracts reject loading, never degrade approval. */
export async function loadCommandApprovalHost(): Promise<CommandApprovalHost> {
	const [root, settings, tokenizer, approvalModule] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/exec/settings"),
		import("@oh-my-pi/pi-coding-agent/tools/shell-tokenize"),
		import("@oh-my-pi/pi-coding-agent/tools/approval"),
	]);
	const registryClass: unknown = root.AgentRegistry;
	const global = typeof registryClass === "function" && "global" in registryClass ? registryClass.global : undefined;
	if (typeof global !== "function") throw new Error("omp-unified-exec: host lacks AgentRegistry.global()");
	const registry: unknown = global.call(registryClass);
	const get = exportedFunction(registry, "get", "AgentRegistry") as (agentId: string) => unknown;
	const patterns = settingReader(settings, "cfgBashPatterns");
	const compound = settingReader(settings, "cfgBashAllowCompoundCommands");
	const criticalPatterns: unknown = root.CRITICAL_BASH_PATTERNS;
	if (!Array.isArray(criticalPatterns) || !criticalPatterns.every((pattern: unknown) => pattern instanceof RegExp)) {
		throw new Error("omp-unified-exec: host lacks CRITICAL_BASH_PATTERNS");
	}
	return {
		registeredSession: (agentId) => {
			const ref: unknown = get.call(registry, agentId);
			return typeof ref === "object" && ref !== null && "session" in ref ? { session: ref.session } : undefined;
		},
		approvalRules: (sessionSettings) => getBashApprovalPatternRules(patterns(sessionSettings)),
		allowCompoundCommands: (sessionSettings) => {
			const value = compound(sessionSettings);
			if (typeof value !== "boolean") throw new Error("omp-unified-exec: bash.allowCompoundCommands must be boolean");
			return value;
		},
		helpers: {
			criticalPatterns,
			tokenizeShellSegments: exportedFunction(tokenizer, "tokenizeShellSegments", "tools/shell-tokenize") as ApprovalHelpers["tokenizeShellSegments"],
			extractLiteralAndChainSegments: exportedFunction(tokenizer, "extractLiteralAndChainSegments", "tools/shell-tokenize") as ApprovalHelpers["extractLiteralAndChainSegments"],
			truncateForPrompt: exportedFunction(approvalModule, "truncateForPrompt", "tools/approval") as ApprovalHelpers["truncateForPrompt"],
		},
	};
}
