/**
 * `exec.initFile`: a POSIX shell script that every exec_command shell sources
 * before running its command, so presets (`export NAME=value`) and command
 * overrides (`alias omp='omp --hide-thinking'`) reach exec_command terminals
 * only. The value is the host's plugin setting: the user value from
 * /settings → Plugins or `omp plugin config`, replaced by a project's
 * `.omp/plugin-overrides.json` value. Read for each call; the file is trusted
 * startup code that command approval, which sees only `cmd`, does not inspect.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { IS_WINDOWS, isPosixShell, type LaunchShell, shellBase } from "../src/shell.ts";
import type { PluginSettingsReader } from "./plugin-settings.ts";

export const INIT_FILE_KEY = "exec.initFile";

/** The setting as one call sees it; a configured file is absolute and was a regular file when read. */
export type InitFile =
	| { readonly kind: "none" }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "invalid"; readonly reason: string };

/** `~` and `~/…` name the home directory; other relative paths are relative to the calling session's cwd. */
export function resolveInitPath(raw: string, cwd: string, home: string): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/") || (IS_WINDOWS && raw.startsWith("~\\"))) return resolve(home, raw.slice(2));
	return resolve(cwd, raw);
}

/** Parse the merged plugin settings; a blank value disables a user value a project replaces. */
export function parseInitFile(settings: Readonly<Record<string, unknown>>, cwd: string, home: string = homedir()): InitFile {
	const raw = settings[INIT_FILE_KEY];
	if (raw === undefined) return { kind: "none" };
	if (typeof raw !== "string") return { kind: "invalid", reason: `plugin setting ${INIT_FILE_KEY} must be a string path` };
	const trimmed = raw.trim();
	if (trimmed === "") return { kind: "none" };
	const path = resolveInitPath(trimmed, cwd, home);
	try {
		if (statSync(path).isFile()) return { kind: "file", path };
		return { kind: "invalid", reason: `${INIT_FILE_KEY} is not a regular file: ${path}` };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { kind: "invalid", reason: code === "ENOENT" ? `${INIT_FILE_KEY} does not exist: ${path}` : `${INIT_FILE_KEY} is unreadable: ${path} (${code ?? String(error)})` };
	}
}

/** Read the setting for a call whose session cwd is `cwd`; without omp's settings API there is none. */
export async function loadInitFile(read: PluginSettingsReader | undefined, cwd: string): Promise<InitFile> {
	if (!read) return { kind: "none" };
	let settings: Readonly<Record<string, unknown>>;
	try {
		settings = await read(cwd);
	} catch (error) {
		return { kind: "invalid", reason: `could not read plugin settings for ${INIT_FILE_KEY}: ${error instanceof Error ? error.message : String(error)}` };
	}
	return parseInitFile(settings, cwd);
}

function posixQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Shell variable carrying the init file's status across the check; unset before the command runs. */
const STATUS_VAR = "__omp_unified_exec_init_status";

/** The `-c` script a call runs, or why the call cannot start. */
export type ShellScript =
	| { readonly kind: "ready"; readonly cmd: string }
	| { readonly kind: "unusable"; readonly reason: string };

/**
 * Without an init file the script is `cmd` itself. With one, the script
 * sources it and then runs `cmd` through `eval`: zsh parses a whole `-c`
 * string before running it, so aliases the file defines would not reach a
 * literal command. The source runs outside any `||`/`if` so the file's own
 * `set -e` keeps its meaning; a nonzero status ends the shell before `cmd`.
 *
 * pi-shell is omp's bash 5.3 engine, so it sources and expands aliases like
 * bash, even though its executable is omp.
 */
export function shellScript(initFile: InitFile, shell: LaunchShell, cmd: string, isWindows: boolean = IS_WINDOWS): ShellScript {
	switch (initFile.kind) {
		case "none":
			return { kind: "ready", cmd };
		case "invalid":
			return { kind: "unusable", reason: initFile.reason };
		case "file":
			break;
	}
	const bash = shell.kind === "pi-shell" || shellBase(shell.shell) === "bash";
	if (shell.kind === "shell" && !isPosixShell(shell.shell)) {
		return { kind: "unusable", reason: `${INIT_FILE_KEY} is a POSIX shell script; ${shell.shell} is not sh, bash, dash, ash, ksh or zsh. Unset ${INIT_FILE_KEY} or run the command under a POSIX shell.` };
	}
	// Git Bash's MSYS runtime reads `C:/…` paths reliably.
	const sourced = isWindows ? initFile.path.replaceAll("\\", "/") : initFile.path;
	const lines = [
		// Non-interactive bash expands aliases only with this option.
		...(bash ? ["shopt -s expand_aliases"] : []),
		`. ${posixQuote(sourced)}`,
		`${STATUS_VAR}=$?`,
		`if [ "$${STATUS_VAR}" -ne 0 ]; then exit "$${STATUS_VAR}"; fi`,
		`unset ${STATUS_VAR}`,
		`eval ${posixQuote(cmd)}`,
	];
	return { kind: "ready", cmd: lines.join("\n") };
}
