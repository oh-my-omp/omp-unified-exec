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
	"- `xd://exec_command/interactive` — before sending input to a running terminal, or before using `monitor` with a `condition` or `judge`\n" +
	"- `xd://exec_command/lifecycle` — before relying on a terminal after its command returned, when a notice mentions a reclaim, or before setting `on_exit: wake`\n" +
	"- `xd://exec_command/waiting` — before waiting for something outside your control: a host coming back, CI finishing, a deploy";

export const writeStdinDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		input: readFileSync(new URL("./topics/write-stdin-input.md", import.meta.url), "utf8"),
	}),
};
export const writeStdinTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://write_stdin/input` — before sending input, or when input is rejected, cancelled or observes an exit";

export const setOnExitDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		wake: readFileSync(new URL("./topics/set-on-exit-wake.md", import.meta.url), "utf8"),
	}),
};
export const setOnExitTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://set_on_exit/wake` — before arming or disarming an exit wake, including after a terminal is evicted";

export const monitorDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		subscription: readFileSync(new URL("./topics/monitor-subscription.md", import.meta.url), "utf8"),
	}),
};
export const monitorTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://monitor/subscription` — before starting or cancelling a monitor, before using `judge`, or after a match, judgment, reminder or input-wait alert";

export const killSessionDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		termination: readFileSync(new URL("./topics/kill-session-termination.md", import.meta.url), "utf8"),
	}),
};
export const killSessionTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://kill_session/termination` — before terminating a session, or when termination fails or the terminal stays listed";

export const listSessionsDocumentation: { docTopics(): Readonly<Record<string, string>> } = {
	docTopics: () => ({
		inventory: readFileSync(new URL("./topics/list-sessions-inventory.md", import.meta.url), "utf8"),
	}),
};
export const listSessionsTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `xd://list_sessions/inventory` — before interpreting the inventory, lifecycle state or exit-wake effects of a listing";
