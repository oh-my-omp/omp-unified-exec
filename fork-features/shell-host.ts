/**
 * omp's own cmd.exe test, `procmgr.isCmdShell` from `@oh-my-pi/pi-utils`: the
 * only authority for which explicit shell the plugin refuses. Shell
 * resolution takes it as an argument, so the plugin keeps no list of shells.
 *
 * Loaded in the admitted factory, so an omp that stops exporting it fails
 * plugin loading instead of launching cmd. A stub host has no omp modules and
 * passes its own `ShellHost`.
 */

/** The shell knowledge the plugin borrows from omp instead of reimplementing. */
export interface ShellHost {
	/** Whether `shell` is Windows cmd.exe, which omp-unified-exec never launches. */
	readonly isCmdShell: (shell: string) => boolean;
}

/**
 * A stub host's stand-in: `activate` is called directly by tests, which have no
 * omp modules. A stub host that resolves an explicit shell passes its own
 * `ShellHost` instead of reaching this one.
 */
export const noShellHost: ShellHost = {
	isCmdShell: () => {
		throw new Error("omp-unified-exec: the activating host supplies no cmd.exe test; pass a ShellHost whose isCmdShell classifies an explicit shell");
	},
};

/** Load omp's shell classifier before any tool registers; a reshaped omp fails plugin loading. */
export async function loadShellHost(): Promise<ShellHost> {
	// Dynamic: omp supplies this host-only package at extension load time; the dev dependencies do not have it.
	const utils: unknown = await import("@oh-my-pi/pi-utils");
	const procmgr: unknown = typeof utils === "object" && utils !== null && "procmgr" in utils ? utils.procmgr : undefined;
	const isCmdShell: unknown = typeof procmgr === "object" && procmgr !== null && "isCmdShell" in procmgr ? procmgr.isCmdShell : undefined;
	if (typeof isCmdShell !== "function") {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-utils procmgr lacks isCmdShell(); requalify fork-features/shell-host.ts for this omp version");
	}
	// Checked as a function above; its signature is omp's and has no runtime check.
	return { isCmdShell: isCmdShell as (shell: string) => boolean };
}
