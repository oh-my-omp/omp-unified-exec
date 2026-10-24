/**
 * Input-wait alerts: a running session whose screen has settled on a prompt
 * the agent has not seen.
 *
 * No terminal protocol announces "waiting for input". debconf (which asks
 * openssh-server's sshd_config question during `apt upgrade`) talks to its
 * frontend over its own pipe; the whiptail/dialog frontend reaches the PTY only
 * as ordinary drawing (alternate screen, hidden cursor, box characters). Over
 * ssh the local process state says nothing either. Detection is therefore a
 * heuristic over the rendered screen, applied only after output has been
 * quiet, and every alert says so.
 */

import { sanitizeOutputText } from "../src/output-safety.ts";
import type { InputPromptLabel, TerminalNotice } from "./terminal-notice.ts";

export type InputScreenKind = "normal" | "alternate";

/** One rendered physical row. */
export interface InputScreenRow {
	readonly text: string;
	readonly wrapped: boolean;
}

/** The active screen at a quiet moment; cursor is 0-based within the screen. */
export interface InputScreen {
	readonly kind: InputScreenKind;
	readonly rows: readonly InputScreenRow[];
	readonly cursorRow: number;
	readonly cursorCol: number;
}

export type InputPromptKind = InputPromptLabel;

export interface InputPrompt {
	readonly kind: InputPromptKind;
	/** Sanitized screen lines that show the prompt. */
	readonly lines: readonly string[];
}

/** whiptail/newt draw `<Ok>`, dialog draws `<  OK  >`. */
const DIALOG_BUTTON = /<\s*(?:ok|yes|no|cancel)\s*>/i;
/** Prompts that end where the cursor waits. */
const INLINE_PROMPTS: readonly RegExp[] = [
	// [Y/n], [y/N], [Y/n/q]
	/\[(?:[\w-]{1,12}\/)+[\w-]{1,12}\]/,
	// (yes/no), (yes/no/[fingerprint]), dpkg's (Y/I/N/O/D/Z)
	/\((?:[\w[\]-]{1,14}\/)+[\w[\]-]{1,14}\)/,
	// dpkg conffile: [default=N]
	/\[default=[^\]]*\]/i,
	// sudo, ssh, gpg: "[sudo] password for x:", "Enter passphrase for key '…':"
	/\b(?:password|passphrase|passcode|pin)\b[^:]*:$/i,
	/\b(?:press|hit)\s+(?:enter|return|any key)\b/i,
];
/** less/more waiting on their bottom row. */
const PAGER_PROMPT = /^(?::|.*\(END\)|--More--.*)$/;

const MAX_LINE_CHARS = 1024;
const MAX_DIALOG_LINES = 24;
const INLINE_CONTEXT_LINES = 3;
/** Box-drawing block; dialog frames carry no text. */
const BOX_DRAWING = /[\u2500-\u257f]+/g;

function clean(text: string): string {
	return sanitizeOutputText(text).trimEnd().slice(0, MAX_LINE_CHARS);
}

/** Non-blank logical lines of rows[0, end), joining wrapped continuations. */
function logicalLines(rows: readonly InputScreenRow[], end: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < end; index++) {
		const row = rows[index]!;
		if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
		else lines.push(row.text);
	}
	return lines.map(clean).filter((line) => line !== "");
}

/** The prompt the screen shows, if any. Pure: the caller decides when the screen is quiet and unseen. */
export function detectInputPrompt(screen: InputScreen): InputPrompt | undefined {
	const { rows, cursorRow, cursorCol } = screen;
	if (rows.some((row) => DIALOG_BUTTON.test(row.text))) {
		const lines = logicalLines(rows, rows.length).map((line) => line.replace(BOX_DRAWING, " ").replace(/\s{3,}/g, "  ").trim()).filter((line) => line !== "");
		return { kind: "dialog", lines: lines.slice(0, MAX_DIALOG_LINES) };
	}
	const cursorLine = rows[cursorRow];
	if (!cursorLine || cursorLine.text.slice(cursorCol).trim() !== "") return undefined;
	let start = cursorRow;
	while (start > 0 && rows[start]!.wrapped) start--;
	let beforeCursor = "";
	for (let index = start; index < cursorRow; index++) beforeCursor += rows[index]!.text;
	const prompt = clean(beforeCursor + cursorLine.text.slice(0, cursorCol));
	if (prompt === "") return undefined;
	const context = logicalLines(rows, start).slice(-INLINE_CONTEXT_LINES);
	if (INLINE_PROMPTS.some((pattern) => pattern.test(prompt))) return { kind: "inline", lines: [...context, prompt] };
	if (cursorRow === rows.length - 1 && PAGER_PROMPT.test(prompt)) return { kind: "pager", lines: [...context, prompt] };
	return undefined;
}

/** One undelivered alert; `current` is false once the screen changed, was shown to the agent, or the session ended. */
export interface InputWaitAlert {
	readonly notice: TerminalNotice;
	current(): boolean;
}

export function inputWaitNotice(input: {
	readonly sessionId: number;
	readonly title: string;
	readonly command: string;
	readonly prompt: InputPrompt;
	readonly screen: InputScreenKind;
	readonly quietMs: number;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
}): TerminalNotice {
	return {
		identity: { sessionId: input.sessionId, title: input.title, terminalUrl: input.terminalUrl, logPath: input.logPath },
		body: { kind: "input_wait", command: input.command, prompt: input.prompt.kind, screen: input.screen, quietMs: input.quietMs, lines: input.prompt.lines },
	};
}
