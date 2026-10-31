import type { Language } from "../src/i18n.ts";

/** Owned diagnostics carry facts until the human notification boundary. */
export type StopConfigReason =
	| { readonly kind: "non_mapping"; readonly scope: "root" | "section" }
	| { readonly kind: "unknown_keys"; readonly keys: readonly string[] }
	| { readonly kind: "invalid_stop"; readonly modes: readonly string[] }
	| { readonly kind: "invalid_template"; readonly key: string }
	| { readonly kind: "unknown_placeholders"; readonly key: string; readonly names: readonly string[]; readonly known: readonly string[] }
	| { readonly kind: "ambiguous_files"; readonly names: readonly string[] }
	| { readonly kind: "parse_error"; readonly detail: string };

export type ModelFailure =
	| { readonly kind: "external_error"; readonly model: string; readonly detail: string }
	| { readonly kind: "error"; readonly model: string }
	| { readonly kind: "unparseable_answer"; readonly model: string };

export type StopReason =
	| { readonly kind: "todo_unavailable" }
	| { readonly kind: "todo_no_counts" }
	| { readonly kind: "todo_empty" }
	| { readonly kind: "off" }
	| { readonly kind: "no_session" }
	| { readonly kind: "no_judge" }
	| { readonly kind: "no_smol" }
	| { readonly kind: "aborted" }
	| { readonly kind: "judge_no_choice"; readonly payload: string | undefined }
	| { readonly kind: "models_failed"; readonly failures: readonly ModelFailure[] }
	| { readonly kind: "external_error"; readonly detail: string };

/** Explicit language keeps this usable for stable English model text too. */
export function renderStopConfigReason(reason: StopConfigReason, language: Language): string {
	const zh = language === "zh";
	switch (reason.kind) {
		case "non_mapping":
			return reason.scope === "root"
				? (zh ? "根节点不是映射" : "root is not a mapping")
				: (zh ? "配置段不是映射" : "section is not a mapping");
		case "unknown_keys":
			return zh ? `未知字段 ${reason.keys.join(", ")}；可用字段：stop, judgePrompt, noticeTemplate` : `unknown key ${reason.keys.join(", ")}; known: stop, judgePrompt, noticeTemplate`;
		case "invalid_stop":
			return zh ? `stop：必须为以下值之一：${reason.modes.join(", ")}` : `stop: must be one of ${reason.modes.join(", ")}`;
		case "invalid_template":
			return zh ? `${reason.key}：必须为非空字符串` : `${reason.key}: must be a non-empty string`;
		case "unknown_placeholders": {
			const names = reason.names.map((name) => `{${name}}`).join(", ");
			const known = reason.known.map((name) => `{${name}}`).join(", ");
			return zh ? `${reason.key}：未知占位符 ${names}；可用占位符：${known}` : `${reason.key}: unknown placeholder ${names}; known: ${known}`;
		}
		case "ambiguous_files":
			return zh ? `存在多个 omomp 文件：${reason.names.join(", ")}` : `several omomp files: ${reason.names.join(", ")}`;
		case "parse_error":
			return reason.detail;
	}
}

function renderModelFailure(failure: ModelFailure, language: Language): string {
	switch (failure.kind) {
		case "external_error": return `${failure.model}: ${failure.detail}`;
		case "error": return `${failure.model}: ${language === "zh" ? "错误" : "error"}`;
		case "unparseable_answer": return `${failure.model}: ${language === "zh" ? "无法解析回答" : "unparseable answer"}`;
	}
}

export function renderStopReason(reason: StopReason, language: Language): string {
	const zh = language === "zh";
	switch (reason.kind) {
		case "todo_unavailable": return zh ? "待办列表不可用" : "todo list unavailable";
		case "todo_no_counts": return zh ? "omp-todo-more 回复中没有 counts" : "omp-todo-more reply has no counts";
		case "todo_empty": return zh ? "待办列表为空" : "todo list is empty";
		case "off": return zh ? "完成检测已关闭" : "stop detection is off";
		case "no_session": return zh ? "没有绑定的 omp 会话" : "no bound omp session";
		case "no_judge": return zh ? "judge 角色未解析到模型" : "the judge role resolves no model";
		case "no_smol": return zh ? "@smol 未解析到模型" : "@smol resolves no model";
		case "aborted": return zh ? "已中止" : "aborted";
		case "judge_no_choice": return zh ? `judge 未返回选择：${reason.payload}` : `judge returned no choice: ${reason.payload}`;
		case "models_failed": {
			const failures = reason.failures.map((failure) => renderModelFailure(failure, language)).join("; ");
			return zh ? `所有 @smol 模型均失败：${failures}` : `every @smol model failed: ${failures}`;
		}
		case "external_error": return reason.detail;
	}
}
