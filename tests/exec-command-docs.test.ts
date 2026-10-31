import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execCommandDocumentation, execCommandTopicPointers } from "../fork-features/exec-command-docs.ts";
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

test("exec_command registration owns the provider and ends with full topic pointers", () => {
	const tools = new Map<string, ToolDefinition>();
	activate({
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand: () => {}, registerFlag: () => {}, on: () => {},
	} as unknown as ExtensionAPI);
	const exec = tools.get("exec_command");
	assert.ok(exec);
	assert.ok("docTopics" in exec);
	assert.equal(exec.docTopics, execCommandDocumentation.docTopics);
	assert.ok(exec.description.endsWith(execCommandTopicPointers));
	assert.ok(execCommandTopicPointers.startsWith("\n\nTopics — read the one a call needs before making it:\n"));
	assert.equal(execCommandTopicPointers.split("\n").filter((line) => line.startsWith("- ")).length, 3);
});
