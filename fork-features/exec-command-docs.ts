import { readFileSync } from "node:fs";

/** Read only when omp requests docs, after host admission; Pi's tool type omits this property. */
export const execCommandDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		interactive: readFileSync(new URL("./topics/interactive.md", import.meta.url), "utf8"),
		lifecycle: readFileSync(new URL("./topics/lifecycle.md", import.meta.url), "utf8"),
		waiting: readFileSync(new URL("./topics/waiting.md", import.meta.url), "utf8"),
	}),
};

export const execCommandTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://exec_command/interactive` — before sending input to a running terminal, or before using `monitor` with a `condition`\n" +
	"- `xd://exec_command/lifecycle` — before relying on a terminal after its command returned, when a notice mentions a reclaim, or before setting `on_exit: wake`\n" +
	"- `xd://exec_command/waiting` — before waiting for something outside your control: a host coming back, CI finishing, a deploy";
