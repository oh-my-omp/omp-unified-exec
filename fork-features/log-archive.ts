import { randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream, type Stats, type WriteStream } from "node:fs";
import { link, lstat, open, readdir, unlink, utimes, type FileHandle } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// Session logs whose last write is more than seven days old are replaced by a
// standard gzip `<name>.log.gz` (readable with zcat); their content is never
// dropped. A log is archived only once its writer is provably gone:
// - this process's logs: the stream has closed (`openLogs` is the record of
//   every log stream this process still holds, across activations/reloads);
// - another process's logs: the owner pid in the name no longer exists, or
//   the log was last written before the machine's last boot;
// - legacy names without an owner pid: last written before the last boot.

export const LOG_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = "pi-unified-exec-";

interface LogArchiveRegistry {
	readonly openLogs: Set<string>;
	timer: NodeJS.Timeout | undefined;
	scan: Promise<readonly ArchiveResult[]> | undefined;
}

// A child agent and an extension reload may load another copy of this module;
// open log streams outlive the activation that created them.
const registrySymbol = Symbol.for("omp-unified-exec.log-archive");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: LogArchiveRegistry };
const registry: LogArchiveRegistry = processGlobal[registrySymbol] ??= { openLogs: new Set(), timer: undefined, scan: undefined };
/** Log paths whose stream this process still holds open. */
export const openSessionLogs: ReadonlySet<string> = registry.openLogs;

export type LogName =
	| { readonly kind: "owned"; readonly pid: number }
	| { readonly kind: "legacy" };

export type SkipReason =
	| "not_regular"
	| "foreign_owner"
	| "recent"
	| "writer_alive"
	| "changed"
	| "archive_exists"
	| "error";

export type ArchiveResult =
	| { readonly name: string; readonly kind: "archived" }
	| { readonly name: string; readonly kind: "skipped"; readonly reason: SkipReason; readonly detail?: string };

export interface ArchivePolicy {
	readonly now: number;
	/** Wall-clock time of the last boot; no process survives it. */
	readonly bootTime: number;
	readonly selfPid: number;
	readonly openLogs: ReadonlySet<string>;
	readonly pidExists: (pid: number) => boolean;
}

/** The log file name for a new session of this process. */
export function sessionLogName(sessionId: number): string {
	return `${LOG_PREFIX}${process.pid}-${sessionId}-${randomBytes(4).toString("hex")}.log`;
}

export function parseLogName(name: string): LogName | undefined {
	const owned = /^pi-unified-exec-(\d+)-\d+-[0-9a-f]{8}\.log$/.exec(name);
	if (owned) return { kind: "owned", pid: Number(owned[1]) };
	if (/^pi-unified-exec-\d+-[0-9a-f]{8}\.log$/.test(name)) return { kind: "legacy" };
	return undefined;
}

/** Record an open log stream until it closes; its fd is the writer this module must never orphan. */
export function trackOpenLog(path: string, stream: WriteStream): void {
	registry.openLogs.add(path);
	stream.once("close", () => registry.openLogs.delete(path));
}

/** POSIX existence probe: only ESRCH proves the pid is gone; anything else counts as alive. */
export function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function writerGone(path: string, name: LogName, mtimeMs: number, policy: ArchivePolicy): boolean {
	if (mtimeMs < policy.bootTime) return true;
	switch (name.kind) {
		case "legacy": return false;
		case "owned":
			return name.pid === policy.selfPid ? !policy.openLogs.has(path) : !policy.pidExists(name.pid);
	}
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function removeQuietly(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}

/** Archive one candidate; never throws, and never removes the source unless its gzip is published. */
export async function archiveLog(dir: string, fileName: string, name: LogName, policy: ArchivePolicy): Promise<ArchiveResult> {
	const path = join(dir, fileName);
	const skip = (reason: SkipReason, detail?: string): ArchiveResult => ({ name: fileName, kind: "skipped", reason, detail });
	let source: FileHandle | undefined;
	let temp: string | undefined;
	try {
		const before = await lstat(path);
		if (!before.isFile()) return skip("not_regular");
		const uid = process.getuid?.();
		if (uid !== undefined && before.uid !== uid) return skip("foreign_owner");
		if (before.mtimeMs > policy.now || policy.now - before.mtimeMs < LOG_ARCHIVE_AGE_MS) return skip("recent");
		if (!writerGone(path, name, before.mtimeMs, policy)) return skip("writer_alive");

		source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (!sameFile(before, await source.stat())) return skip("changed");

		temp = join(dir, `${fileName}.gz.${randomBytes(6).toString("hex")}.tmp`);
		await pipeline(
			createReadStream("", { fd: source.fd, autoClose: false, start: 0 }),
			createGzip(),
			createWriteStream(temp, { flags: "wx", mode: 0o600 }),
		);
		const written = await open(temp, "r+");
		try {
			await written.sync();
		} finally {
			await written.close();
		}
		await utimes(temp, before.atime, before.mtime);
		if (!sameFile(before, await source.stat())) return skip("changed");
		await source.close();
		source = undefined;

		const archive = `${path}.gz`;
		try {
			await link(temp, archive);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return skip("archive_exists");
			throw err;
		}
		const current = await lstat(path);
		if (!current.isFile() || !sameFile(before, current)) {
			await removeQuietly(archive);
			return skip("changed");
		}
		await unlink(path);
		return { name: fileName, kind: "archived" };
	} catch (err) {
		return skip("error", err instanceof Error ? err.message : String(err));
	} finally {
		await source?.close().catch(() => undefined);
		if (temp) await removeQuietly(temp);
	}
}

/** Archive every eligible session log in `dir`, one at a time. */
export async function archiveLogs(dir: string, policy: ArchivePolicy): Promise<readonly ArchiveResult[]> {
	const results: ArchiveResult[] = [];
	for (const fileName of await readdir(dir)) {
		const name = parseLogName(fileName);
		if (name) results.push(await archiveLog(dir, fileName, name, policy));
	}
	return results;
}

function runScan(): void {
	if (registry.scan) return;
	const now = Date.now();
	const policy: ArchivePolicy = { now, bootTime: now - uptime() * 1000, selfPid: process.pid, openLogs: registry.openLogs, pidExists };
	registry.scan = archiveLogs(tmpdir(), policy)
		.catch((): readonly ArchiveResult[] => [])
		.finally(() => { registry.scan = undefined; });
}

/** Scan now and daily for as long as the process lives; a newer activation replaces the timer. */
export function scheduleLogArchive(): void {
	clearInterval(registry.timer);
	registry.timer = setInterval(runScan, SCAN_INTERVAL_MS);
	registry.timer.unref();
	runScan();
}
