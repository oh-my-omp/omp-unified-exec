import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadStopConfig, parseStopSection } from "../fork-features/stop-config.ts";
import { renderStopConfigReason, renderStopReason, type StopConfigReason, type StopReason } from "../fork-features/stop-reasons.ts";

const configCases: readonly [StopConfigReason, string, string][] = [
	[{ kind: "non_mapping", scope: "root" }, "root is not a mapping", "根节点不是映射"],
	[{ kind: "non_mapping", scope: "section" }, "section is not a mapping", "配置段不是映射"],
	[{ kind: "unknown_keys", keys: ["typo"] }, "unknown key typo; known: stop, judgePrompt, noticeTemplate", "未知字段 typo；可用字段：stop, judgePrompt, noticeTemplate"],
	[{ kind: "invalid_stop", modes: ["auto", "off"] }, "stop: must be one of auto, off", "stop：必须为以下值之一：auto, off"],
	[{ kind: "invalid_template", key: "judgePrompt" }, "judgePrompt: must be a non-empty string", "judgePrompt：必须为非空字符串"],
	[{ kind: "unknown_placeholders", key: "noticeTemplate", names: ["typo"], known: ["summary"] }, "noticeTemplate: unknown placeholder {typo}; known: {summary}", "noticeTemplate：未知占位符 {typo}；可用占位符：{summary}"],
	[{ kind: "ambiguous_files", names: ["omomp.yml", "omomp.json"] }, "several omomp files: omomp.yml, omomp.json", "存在多个 omomp 文件：omomp.yml, omomp.json"],
	[{ kind: "parse_error", detail: "external parser payload" }, "external parser payload", "external parser payload"],
];
const stopCases: readonly [StopReason, string, string][] = [
	[{ kind: "todo_unavailable" }, "todo list unavailable", "待办列表不可用"],
	[{ kind: "todo_no_counts" }, "omp-todo-more reply has no counts", "omp-todo-more 回复中没有 counts"],
	[{ kind: "todo_empty" }, "todo list is empty", "待办列表为空"],
	[{ kind: "off" }, "stop detection is off", "完成检测已关闭"],
	[{ kind: "no_session" }, "no bound omp session", "没有绑定的 omp 会话"],
	[{ kind: "no_judge" }, "the judge role resolves no model", "judge 角色未解析到模型"],
	[{ kind: "no_smol" }, "@smol resolves no model", "@smol 未解析到模型"],
	[{ kind: "aborted" }, "aborted", "已中止"],
	[{ kind: "judge_no_choice", payload: '{"choice":"x"}' }, 'judge returned no choice: {"choice":"x"}', 'judge 未返回选择：{"choice":"x"}'],
	[{ kind: "judge_no_choice", payload: undefined }, "judge returned no choice: undefined", "judge 未返回选择：undefined"],
	[{ kind: "models_failed", failures: [{ kind: "error", model: "p/a" }, { kind: "external_error", model: "p/b", detail: "quota 429" }, { kind: "unparseable_answer", model: "p/c" }] }, "every @smol model failed: p/a: error; p/b: quota 429; p/c: unparseable answer", "所有 @smol 模型均失败：p/a: 错误; p/b: quota 429; p/c: 无法解析回答"],
	[{ kind: "external_error", detail: "external exception" }, "external exception", "external exception"],
];

describe("stop diagnostic facts and boundary rendering", () => {
	it("renders all config reasons in en and zh while retaining data", () => {
		for (const [reason, en, zh] of configCases) {
			assert.equal(renderStopConfigReason(reason, "en"), en);
			assert.equal(renderStopConfigReason(reason, "zh"), zh);
		}
	});
	it("renders all detector reasons and model failures in en and zh", () => {
		for (const [reason, en, zh] of stopCases) {
			assert.equal(renderStopReason(reason, "en"), en);
			assert.equal(renderStopReason(reason, "zh"), zh);
		}
	});
	it("parses owned section problems as structured facts, not English prose", () => {
		assert.deepEqual(parseStopSection("bad"), { kind: "error", reason: { kind: "non_mapping", scope: "section" } });
		assert.deepEqual(parseStopSection({ typo: true }), { kind: "error", reason: { kind: "unknown_keys", keys: ["typo"] } });
		assert.deepEqual(parseStopSection({ judgePrompt: " " }), { kind: "error", reason: { kind: "invalid_template", key: "judgePrompt" } });
		assert.deepEqual(parseStopSection({ noticeTemplate: "{typo}" }), { kind: "error", reason: { kind: "unknown_placeholders", key: "noticeTemplate", names: ["typo"], known: ["summary", "items", "instruction", "terminal_count", "notice_count"] } });
	});
	it("keeps file-source problems structured and accepts a valid fallback", () => {
		const dir = mkdtempSync(join(tmpdir(), "unified-stop-reasons-"));
		try {
			const project = join(dir, "project");
			const agent = join(dir, "agent");
			mkdirSync(join(project, ".omp"), { recursive: true });
			mkdirSync(agent);
			writeFileSync(join(project, ".omp", "omomp.json"), JSON.stringify({ "omp-unified-exec": "bad" }));
			writeFileSync(join(agent, "omomp.json"), JSON.stringify({ "omp-unified-exec": { stop: "off" } }));
			const load = loadStopConfig(project, agent);
			assert.equal(load.config.mode, "off");
			assert.deepEqual(load.problems, [{ path: `${join(project, ".omp", "omomp.json")}#omp-unified-exec`, reason: { kind: "non_mapping", scope: "section" } }]);
			const reason = load.problems[0].reason;
			const identity = JSON.stringify(reason);
			assert.equal(renderStopConfigReason(reason, "zh"), "配置段不是映射");
			assert.equal(renderStopConfigReason(reason, "en"), "section is not a mapping");
			assert.equal(JSON.stringify(reason), identity, "rendering never changes locale-independent diagnostic identity");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
