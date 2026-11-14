/**
 * The stub-host shell seam the test harnesses share.
 *
 * `activate` is called directly by tests, so there is no omp behind the
 * ExtensionAPI: no pi-shell executable (`process.execPath` is bun) and no
 * `procmgr.isCmdShell`. A harness therefore names the shell its own suite runs
 * under on Windows — `bash`, Git for Windows in CI — and answers the cmd test
 * with the same name rule the host uses.
 */
import { IS_WINDOWS } from "../src/shell.ts";

/** On Windows the stub host has no pi-shell, so it names the bash the suite runs under. */
export const STUB_SHELL_PATH = IS_WINDOWS ? () => "bash" : () => undefined;

/** The stub host's cmd.exe test, as omp's `procmgr.isCmdShell` answers it. */
export const stubShellHost = {
	isCmdShell: (shell: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(shell),
} as const;
