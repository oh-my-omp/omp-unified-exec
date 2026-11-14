/**
 * Shell selection and command-line construction, cross-platform.
 *
 * A call that names no shell — no `shell` argument, no omp `shellPath`, no
 * `SHELL` — runs in omp's own pi-shell on Windows: the omp executable's `bash`
 * subcommand, which exists wherever omp does. POSIX keeps `bash`. An explicit
 * choice is used as given, except cmd.exe: the host's `procmgr.isCmdShell`
 * recognizes it and the plugin refuses it rather than launching a shell whose
 * command language is neither POSIX nor omp's.
 */

import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** Executable extensions probed on Windows (PATHEXT order), plus bare. */
const WINDOWS_EXEC_EXTS = [".com", ".exe", ".bat", ".cmd", ""];

/**
 * Extensions valid for a SHELL binary. Only formats CreateProcess runs
 * directly: a .cmd/.bat wrapper would be executed by cmd.exe, not by the
 * shell the caller asked for.
 */
const WINDOWS_SHELL_EXTS = [".com", ".exe"];

/** statSync().isFile() that never throws. */
export function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Basename without a Windows executable extension, lowercased. */
export function shellBase(shellBin: string): string {
	const base = shellBin.split(/[\\/]/).pop() ?? shellBin;
	return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

// The host's own test, copied from packages/utils/src/procmgr.ts: isPosixShell.
const POSIX_SHELL_PATTERN = /(?:^|[\\/])(?:sh|bash|dash|ash|ksh|zsh)(?:\.exe)?$/i;

/** Whether omp treats `shell` as a POSIX shell (sh, bash, dash, ash, ksh, zsh). */
export function isPosixShell(shell: string): boolean {
	return POSIX_SHELL_PATTERN.test(shell);
}

/**
 * Build the argv for running `cmd` under the given shell executable.
 */
export function buildShellCommand(shellBin: string, cmd: string): string[] {
	const base = shellBase(shellBin);
	// powershell/pwsh take -Command on every platform (pwsh is cross-platform).
	if (base === "powershell" || base === "pwsh") {
		// -NoLogo: no banner on the PTY screen. No -NonInteractive: in a PTY it
		// would block interactive prompts the session is meant to answer.
		return [shellBin, "-NoProfile", "-NoLogo", "-Command", cmd];
	}
	// bash, sh, zsh, fish, … all take -c.
	return [shellBin, "-c", cmd];
}

export interface FindOnPathOptions {
	/** Extensions to probe, in order. Defaults per-platform. */
	exts?: string[];
	/** Skip matches whose full path matches this pattern. */
	exclude?: RegExp;
}

/**
 * Find `bin` on PATH and return its absolute path. Windows-aware: tries
 * .exe/.cmd/.bat extensions. Only regular files count (a directory named
 * like the binary is skipped).
 */
export function findOnPath(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	opts: FindOnPathOptions = {},
): string | undefined {
	const pathVar = env.PATH ?? env.Path ?? "";
	const exts = opts.exts ?? (IS_WINDOWS ? WINDOWS_EXEC_EXTS : [""]);
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			// resolve() (not join): a relative PATH entry must not yield a
			// cwd-dependent result that breaks when spawned from another cwd.
			const full = resolve(dir, bin + ext);
			if (opts.exclude?.test(full)) continue;
			if (isFile(full)) return full;
		}
	}
	return undefined;
}

/** A shell the plugin launches: omp's pi-shell, or an executable the user chose. */
export type LaunchShell =
	| {
		/** omp's pi-shell, launched as `<shell> bash`. */
		readonly kind: "pi-shell";
		/** The omp executable; `process.execPath` inside omp. */
		readonly shell: string;
	}
	| {
		/** A shell executable, or a bare name to resolve before spawning. */
		readonly kind: "shell";
		readonly shell: string;
	};

/** Where an explicit shell choice came from; a refusal names it. */
export type ShellSource = "call" | "shellPath" | "SHELL";

/** The shell a call runs in, or the refusal reported instead of launching one. */
export type ShellChoice =
	| LaunchShell
	| {
		/** An explicit choice the plugin never launches. */
		readonly kind: "refused";
		/** The refused executable; nothing is spawned. */
		readonly shell: string;
		/** Why it is refused: cmd.exe has neither POSIX syntax nor pi-shell's engine. */
		readonly reason: "cmd";
		/** The setting that supplied it. */
		readonly source: ShellSource;
	};

export interface DefaultShellOptions {
	/** The omp executable pi-shell runs through. Defaults to `process.execPath`, omp's own binary inside omp. */
	readonly omp?: string;
	/** Platform branch. Defaults to the real platform, so tests can drive the Windows default anywhere. */
	readonly isWindows?: boolean;
	/** Which source supplied `requested`; the `SHELL` fallback is its own. */
	readonly requestedSource?: "call" | "shellPath";
	/**
	 * The host's cmd.exe test (`procmgr.isCmdShell`). Production passes omp's;
	 * a stub host that cannot load it passes its own.
	 */
	readonly isCmdShell: (shell: string) => boolean;
}

/**
 * The shell a call runs in: the caller's explicit choice (its `shell`
 * argument, then omp's live `shellPath`), then `SHELL`, then the platform
 * default. A blank choice counts as unset. An explicit cmd.exe is refused —
 * never substituted by a lower-priority shell.
 */
export function resolveDefaultShell(
	env: NodeJS.ProcessEnv | undefined,
	requested: string | undefined,
	options: DefaultShellOptions,
): ShellChoice {
	const choice = requested?.trim();
	const explicit = choice || (env ?? process.env).SHELL?.trim();
	if (explicit) {
		return options.isCmdShell(explicit)
			? { kind: "refused", shell: explicit, reason: "cmd", source: choice ? (options.requestedSource ?? "call") : "SHELL" }
			: { kind: "shell", shell: explicit };
	}
	if (options.isWindows ?? IS_WINDOWS) return { kind: "pi-shell", shell: options.omp ?? process.execPath };
	return { kind: "shell", shell: "bash" };
}

/**
 * The argv that runs `cmd` in a launched shell. pi-shell is omp's own `bash`
 * subcommand; `-c` — not the interactive REPL `omp bash` starts without it —
 * keeps a session one command whose exit ends the shell, as an explicit bash
 * gets.
 */
export function shellArgv(shell: LaunchShell, cmd: string): string[] {
	switch (shell.kind) {
		case "pi-shell":
			return [shell.shell, "bash", "-c", cmd];
		case "shell":
			return buildShellCommand(shell.shell, cmd);
	}
}

const resolvedBinaryCache = new Map<string, string>();

/**
 * Resolve a bare binary name to an absolute path via PATH, with caching.
 * Names that already contain a directory component pass through untouched,
 * as do names that can't be resolved (the spawn will surface the error).
 *
 * Spawning the resolved absolute path (instead of the bare name) keeps the
 * probed binary and the spawned binary identical, and avoids Windows'
 * CreateProcess cwd-first lookup — a `bash.exe` planted in an untrusted
 * workdir must not shadow the real shell.
 */
export function resolveBinary(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin;
	if (env) return findOnPath(bin, env) ?? bin; // test hook: no caching
	const cached = resolvedBinaryCache.get(bin);
	if (cached) return cached;
	const resolved = findOnPath(bin) ?? bin;
	resolvedBinaryCache.set(bin, resolved);
	return resolved;
}

/** System32's bash.exe is the WSL stub — a different OS view entirely. */
const SYSTEM32_RE = /[\\/]system32[\\/]/i;

/**
 * Resolve a Windows SHELL binary to an absolute path, failing closed.
 *
 * Unlike resolveBinary, an unresolvable bare name throws instead of passing
 * through: spawning a bare name lets CreateProcess check the child's cwd
 * (the LLM-supplied workdir) first, so "powershell" with a mangled PATH
 * would happily execute an attacker's powershell.exe from an untrusted
 * repo. Only .com/.exe are accepted (Node can't spawn .cmd/.bat directly).
 *
 * `PI_UNIFIED_EXEC_BASH` names the bash to use whenever a bash is resolved,
 * ahead of PATH; other shell names ignore it.
 */
export function resolveWindowsShell(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin; // explicit path: caller's responsibility
	const cacheKey = `shell:${bin}`;
	if (!env) {
		const cached = resolvedBinaryCache.get(cacheKey);
		if (cached) return cached;
	}
	const effectiveEnv = env ?? process.env;
	const bash = bin.replace(/\.(exe|com)$/i, "").toLowerCase() === "bash";
	const override = bash ? effectiveEnv.PI_UNIFIED_EXEC_BASH?.trim() : undefined;
	const found = override && isFile(override)
		? override
		// A bash name must not land on System32's WSL stub (a different OS view).
		: findOnPath(bin, effectiveEnv, { exts: WINDOWS_SHELL_EXTS, exclude: bash ? SYSTEM32_RE : undefined });
	if (!found) {
		throw new Error(
			bash
				? `bash not found on PATH (searched ${WINDOWS_SHELL_EXTS.join("/")}). Install Git for Windows, set PI_UNIFIED_EXEC_BASH to your bash.exe, or omit shell to run in omp's pi-shell (omp bash).`
				: `shell "${bin}" not found on PATH (searched ${WINDOWS_SHELL_EXTS.join("/")}). Pass an absolute path, or use "powershell" or an installed bash.`,
		);
	}
	if (!env) resolvedBinaryCache.set(cacheKey, found);
	return found;
}

/** Test hook: forget cached binary probes. */
export function resetDefaultShellCache(): void {
	resolvedBinaryCache.clear();
}
