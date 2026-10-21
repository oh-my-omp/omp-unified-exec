/*
 * Convert untrusted child/argument text into inert terminal text.
 *
 * A PTY can emit more than color: OSC clipboard writes, alternate-screen and
 * keyboard-mode CSI sequences, DCS payloads, and other controls can reprogram
 * the host terminal when replayed by a custom TUI renderer. Unified-exec keeps
 * the exact byte stream in log_path; model/session/TUI output is plain text.
 */

const ESC = "\x1b";

function isCsiParam(code: number): boolean {
	return code >= 0x30 && code <= 0x3f;
}

function isCsiIntermediate(code: number): boolean {
	return code >= 0x20 && code <= 0x2f;
}

function isCsiFinal(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

type SanitizerState = "text" | "esc" | "esc-intermediate" | "csi-param" | "csi-intermediate" | "osc" | "osc-esc" | "string" | "string-esc";

/** Remove control sequences from `input`, keeping printable text, tabs and newlines. */
function stripControls(input: string): string {
	let state: SanitizerState = "text";
	let output = "";
	let i = 0;
	while (i < input.length) {
		if (state === "text") {
			const start = i;
			while (i < input.length) {
				const code = input.charCodeAt(i);
				if ((code < 0x20 && code !== 0x09 && code !== 0x0a) ||
					(code >= 0x7f && code <= 0x9f) || (code >= 0xfff9 && code <= 0xfffb)) break;
				if (code >= 0xd800 && code <= 0xdbff) {
					const next = input.charCodeAt(i + 1);
					if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) break;
					i += 2;
				} else if (code >= 0xdc00 && code <= 0xdfff) break;
				else i++;
			}
			if (i > start) output += input.slice(start, i);
			if (i === input.length) break;
			const code = input.charCodeAt(i++);
			if (code === 0x1b) state = "esc";
			else if (code === 0x9b) state = "csi-param";
			else if (code === 0x9d) state = "osc";
			else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = "string";
			continue;
		}

		const ch = input[i]!;
		const code = input.charCodeAt(i);
		switch (state) {
			case "esc":
				if (ch === "[") state = "csi-param";
				else if (ch === "]") state = "osc";
				else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") state = "string";
				else state = isCsiIntermediate(code) ? "esc-intermediate" : "text";
				i++;
				break;
			case "esc-intermediate":
				if (!isCsiIntermediate(code)) state = "text";
				i++;
				break;
			case "csi-param":
				if (isCsiParam(code)) i++;
				else if (isCsiIntermediate(code)) { state = "csi-intermediate"; i++; }
				else if (isCsiFinal(code)) { state = "text"; i++; }
				else state = "text"; // Malformed suffix is reprocessed, not swallowed.
				break;
			case "csi-intermediate":
				if (isCsiIntermediate(code)) i++;
				else if (isCsiFinal(code)) { state = "text"; i++; }
				else state = "text";
				break;
			case "osc":
			case "string":
				if (code === 0x9c || (state === "osc" && code === 0x07)) state = "text";
				else if (ch === ESC) state = state === "osc" ? "osc-esc" : "string-esc";
				i++;
				break;
			case "osc-esc":
			case "string-esc":
				if (ch === "\\" || code === 0x9c || (state === "osc-esc" && code === 0x07)) state = "text";
				else if (ch !== ESC) state = state === "osc-esc" ? "osc" : "string";
				i++;
				break;
		}
	}
	return output;
}

/**
 * Strip ANSI/VT sequences and C0/C1 controls while retaining printable text,
 * tabs, and newlines. Carriage return cannot rewrite an earlier transcript line.
 */
export function sanitizeOutputText(input: string): string {
	if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff\ufff9-\ufffb]/.test(input)) return input;
	return stripControls(input);
}
