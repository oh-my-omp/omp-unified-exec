import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	execCommandDocumentation, execCommandTopicPointers,
	writeStdinDocumentation, writeStdinTopicPointers,
	setOnExitDocumentation, setOnExitTopicPointers,
	monitorDocumentation, monitorTopicPointers,
	killSessionDocumentation, killSessionTopicPointers,
	listSessionsDocumentation, listSessionsTopicPointers,
} from "../fork-features/exec-command-docs.ts";
import { activate } from "../src/index.ts";

test("exec_command provides the three packaged, body-only topics", () => {
	const topics = execCommandDocumentation.docTopics();
	assert.deepEqual(Object.keys(topics), ["interactive", "lifecycle", "waiting"]);
	for (const [name, body] of Object.entries(topics)) {
		assert.equal(body, readFileSync(new URL(`../fork-features/topics/${name}.md`, import.meta.url), "utf8"));
		assert.ok(body.startsWith("# "));
		assert.ok(!body.includes("tool://exec_command/"));
		assert.ok(execCommandTopicPointers.includes(`- \`xd://exec_command/${name}\` — `));
	}
	assert.equal(Object.hasOwn(topics, "nope"), false);
});

test("waiting documents the plugin contract without the local polling policy", () => {
	const { waiting, interactive } = execCommandDocumentation.docTopics();
	assert.match(waiting, /yield_time_ms/);
	assert.match(waiting, /without `condition`/);
	assert.match(waiting, /observes without consuming output/);
	assert.doesNotMatch(waiting, /seq 288|sleep 300|Do not loop|Never add a per-check marker/);
	assert.ok(interactive.includes("ssh host bash -s <<'EOF'"));
});

test("all six registrations own packaged providers and end with full topic pointers", () => {
	const tools = new Map<string, ToolDefinition>();
	activate({
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand: () => {}, registerFlag: () => {}, on: () => {},
	} as unknown as ExtensionAPI);
	const definitions = [
		["exec_command", execCommandDocumentation, execCommandTopicPointers, ["interactive", "lifecycle", "waiting"]],
		["write_stdin", writeStdinDocumentation, writeStdinTopicPointers, ["write-stdin-input"]],
		["set_on_exit", setOnExitDocumentation, setOnExitTopicPointers, ["set-on-exit-wake"]],
		["monitor", monitorDocumentation, monitorTopicPointers, ["monitor-subscription"]],
		["kill_session", killSessionDocumentation, killSessionTopicPointers, ["kill-session-termination"]],
		["list_sessions", listSessionsDocumentation, listSessionsTopicPointers, ["list-sessions-inventory"]],
	] as const;
	assert.equal(tools.size, definitions.length);
	for (const [name, documentation, pointers, files] of definitions) {
		const tool = tools.get(name);
		assert.ok(tool);
		assert.ok("docTopics" in tool);
		assert.equal(tool.docTopics, documentation.docTopics);
		assert.ok(tool.description.endsWith(pointers));
		assert.ok(pointers.startsWith("\n\nTopics — read the one a call needs before making it:\n"));
		const topics = documentation.docTopics();
		assert.equal(pointers.split("\n").filter((line) => line.startsWith("- ")).length, Object.keys(topics).length);
		for (const [[topic, body], index] of Object.entries(topics).map((entry, index) => [entry, index] as const)) {
			assert.equal(body, readFileSync(new URL(`../fork-features/topics/${files[index]}.md`, import.meta.url), "utf8"));
			assert.ok(body.startsWith("# "));
			assert.ok(!body.startsWith("---"));
			assert.ok(!body.includes("tool://"));
			assert.ok(pointers.includes(`- \`xd://${name}/${topic}\` — `));
		}
		assert.equal(Object.hasOwn(topics, "nope"), false);
	}
	const exec = tools.get("exec_command")!;
	assert.doesNotMatch(exec.description, /30 minutes|screen_changed|Notices name/);
	assert.match(execCommandDocumentation.docTopics().interactive, /screen_changed:false/);
	assert.match(execCommandDocumentation.docTopics().lifecycle, /Notices name.*session_id.*title/);
});
