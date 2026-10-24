import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { type ArchivePolicy, type ArchiveResult, archiveLogs, LOG_ARCHIVE_AGE_MS, openSessionLogs, pidExists, trackOpenLog } from "../fork-features/log-archive.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 12);
const BOOT = NOW - 3 * DAY;
const SELF = 4242;
const OTHER = 777;

let dir: string;

function policy(overrides: Partial<ArchivePolicy> = {}): ArchivePolicy {
	return { now: NOW, bootTime: BOOT, selfPid: SELF, openLogs: new Set(), pidExists: () => false, ...overrides };
}

async function writeLog(name: string, content: Buffer | string, mtime: number): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, content);
	await utimes(path, new Date(mtime), new Date(mtime));
	return path;
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false);
}

/** Outcome per file name; directory listing order is not specified. */
function outcomes(results: readonly ArchiveResult[]): Record<string, string> {
	return Object.fromEntries(results.map((r) => [r.name, r.kind === "skipped" ? r.reason : r.kind]));
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "log-archive-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("log archive", () => {
	it("replaces a dead owner's week-old log with a byte-identical gzip carrying its mtime", async () => {
		const content = Buffer.concat([randomBytes(256 * 1024), Buffer.from("\x1b[31mtail\x1b[0m\r\n")]);
		const mtime = NOW - LOG_ARCHIVE_AGE_MS - 1000;
		const path = await writeLog(`pi-unified-exec-${OTHER}-3-0a1b2c3d.log`, content, mtime);

		const results = await archiveLogs(dir, policy({ bootTime: mtime - DAY }));

		assert.deepEqual(results, [{ name: `pi-unified-exec-${OTHER}-3-0a1b2c3d.log`, kind: "archived" }]);
		assert.equal(await exists(path), false);
		assert.deepEqual(gunzipSync(await readFile(`${path}.gz`)), content);
		assert.equal(Math.round((await stat(`${path}.gz`)).mtimeMs / 1000), Math.round(mtime / 1000));
		assert.deepEqual(await readdir(dir), [`pi-unified-exec-${OTHER}-3-0a1b2c3d.log.gz`]);
	});

	it("leaves logs written within seven days, or in the future, untouched", async () => {
		const recent = await writeLog(`pi-unified-exec-${OTHER}-1-00000001.log`, "recent", NOW - LOG_ARCHIVE_AGE_MS + DAY);
		const future = await writeLog(`pi-unified-exec-${OTHER}-2-00000002.log`, "future", NOW + DAY);

		const results = await archiveLogs(dir, policy({ bootTime: NOW + 2 * DAY }));

		assert.deepEqual(outcomes(results), {
			[`pi-unified-exec-${OTHER}-1-00000001.log`]: "recent",
			[`pi-unified-exec-${OTHER}-2-00000002.log`]: "recent",
		});
		assert.equal(await readFile(recent, "utf8"), "recent");
		assert.equal(await readFile(future, "utf8"), "future");
	});

	it("keeps this process's open logs and archives its closed ones", async () => {
		const old = NOW - 10 * DAY;
		const open = await writeLog(`pi-unified-exec-${SELF}-1-0000000a.log`, "open", old);
		const closed = await writeLog(`pi-unified-exec-${SELF}-2-0000000b.log`, "closed", old);

		const results = await archiveLogs(dir, policy({ bootTime: old - DAY, openLogs: new Set([open]), pidExists: () => true }));

		assert.deepEqual(outcomes(results), {
			[`pi-unified-exec-${SELF}-1-0000000a.log`]: "writer_alive",
			[`pi-unified-exec-${SELF}-2-0000000b.log`]: "archived",
		});
		assert.equal(await readFile(open, "utf8"), "open");
		assert.equal(gunzipSync(await readFile(`${closed}.gz`)).toString(), "closed");
	});

	it("keeps another live process's log unless it predates the last boot", async () => {
		const sinceBoot = await writeLog(`pi-unified-exec-${OTHER}-1-0000000c.log`, "live", NOW - 8 * DAY);
		const beforeBoot = await writeLog(`pi-unified-exec-${OTHER}-2-0000000d.log`, "stale", NOW - 9 * DAY);

		const results = await archiveLogs(dir, policy({ bootTime: NOW - 8.5 * DAY, pidExists: (pid) => pid === OTHER }));

		assert.deepEqual(outcomes(results), {
			[`pi-unified-exec-${OTHER}-1-0000000c.log`]: "writer_alive",
			[`pi-unified-exec-${OTHER}-2-0000000d.log`]: "archived",
		});
		assert.equal(await readFile(sinceBoot, "utf8"), "live");
		assert.equal(gunzipSync(await readFile(`${beforeBoot}.gz`)).toString(), "stale");
	});

	it("archives a legacy name without an owner pid only when it predates the last boot", async () => {
		const sinceBoot = await writeLog("pi-unified-exec-5-0000000e.log", "legacy-live", NOW - 8 * DAY);
		const beforeBoot = await writeLog("pi-unified-exec-6-0000000f.log", "legacy-stale", NOW - 9 * DAY);

		const results = await archiveLogs(dir, policy({ bootTime: NOW - 8.5 * DAY }));

		assert.deepEqual(outcomes(results), {
			"pi-unified-exec-5-0000000e.log": "writer_alive",
			"pi-unified-exec-6-0000000f.log": "archived",
		});
		assert.equal(await readFile(sinceBoot, "utf8"), "legacy-live");
		assert.equal(gunzipSync(await readFile(`${beforeBoot}.gz`)).toString(), "legacy-stale");
	});

	it("never overwrites an existing archive and then keeps the source", async () => {
		const path = await writeLog(`pi-unified-exec-${OTHER}-1-00000010.log`, "source", NOW - 10 * DAY);
		await writeFile(`${path}.gz`, "earlier archive");

		const [result] = await archiveLogs(dir, policy());

		assert.equal(result.kind === "skipped" && result.reason, "archive_exists");
		assert.equal(await readFile(path, "utf8"), "source");
		assert.equal(await readFile(`${path}.gz`, "utf8"), "earlier archive");
		assert.deepEqual((await readdir(dir)).sort(), [`pi-unified-exec-${OTHER}-1-00000010.log`, `pi-unified-exec-${OTHER}-1-00000010.log.gz`]);
	});

	it("does not follow a symlink that carries a log name", { skip: process.platform === "win32" }, async () => {
		const target = await writeLog("elsewhere.txt", "not a log", NOW - 10 * DAY);
		const link = join(dir, `pi-unified-exec-${OTHER}-1-00000011.log`);
		await symlink(target, link);

		const [result] = await archiveLogs(dir, policy());

		assert.equal(result.kind === "skipped" && result.reason, "not_regular");
		assert.equal(await readFile(target, "utf8"), "not a log");
		assert.equal(await exists(`${link}.gz`), false);
	});

	it("tracks a real log stream as open until it closes", async () => {
		const path = join(dir, `pi-unified-exec-${process.pid}-1-00000012.log`);
		const stream = createWriteStream(path, { flags: "a" });
		trackOpenLog(path, stream);
		const written = Promise.withResolvers<void>();
		stream.write("first\n", () => written.resolve());
		await written.promise;
		const old = new Date(Date.now() - 10 * DAY);
		await utimes(path, old, old);
		const live: ArchivePolicy = { now: Date.now(), bootTime: old.getTime() - DAY, selfPid: process.pid, openLogs: openSessionLogs, pidExists };

		const [whileOpen] = await archiveLogs(dir, live);
		assert.equal(whileOpen.kind === "skipped" && whileOpen.reason, "writer_alive");

		const closed = once(stream, "close");
		stream.end();
		await closed;
		const [afterClose] = await archiveLogs(dir, live);

		assert.equal(afterClose.kind, "archived");
		assert.equal(gunzipSync(await readFile(`${path}.gz`)).toString(), "first\n");
	});
});
