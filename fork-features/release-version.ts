import { readFile, writeFile } from "node:fs/promises";

// Bumps the fork's patch version for the release workflow
// (.github/workflows/release.yml): package.json, both version fields of
// package-lock.json, and the top `## Unreleased` section of Changelog.md,
// which becomes `## X.Y.Z - YYYY-MM-DD` under a fresh empty `## Unreleased`.
// Prints the new version on stdout. Run from the repository root with Bun.

type Version = { readonly major: number; readonly minor: number; readonly patch: number };

type LockFile = { version: string; packages: { "": { version: string } } };

function parseVersion(text: string, source: string): Version {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (!match) throw new Error(`${source}: version "${text}" is not X.Y.Z`);
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatVersion(version: Version): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * The first `## ` heading after the title must be the active `## Unreleased`.
 * Older `## Unreleased` headings further down are upstream history and stay.
 */
function rotateChangelog(text: string, version: string, date: string): string {
	const lines = text.split("\n");
	const top = lines.findIndex((line) => line.startsWith("## "));
	if (top === -1 || lines[top] !== "## Unreleased") {
		throw new Error("Changelog.md: the first section must be `## Unreleased`");
	}
	lines.splice(top, 1, "## Unreleased", "", `## ${version} - ${date}`);
	return lines.join("\n");
}

const pkgText = await readFile("package.json", "utf8");
const lockText = await readFile("package-lock.json", "utf8");
const changelogText = await readFile("Changelog.md", "utf8");
const pkg = JSON.parse(pkgText) as { version: string };
const lock = JSON.parse(lockText) as LockFile;
const current = pkg.version;
// package.json is the source; the lock only mirrors it, so drift is an error, not something to repair.
if (lock.version !== current || lock.packages[""].version !== current) {
	throw new Error(
		`package-lock.json versions (${lock.version}, ${lock.packages[""].version}) differ from package.json (${current})`,
	);
}
const parsed = parseVersion(current, "package.json");
const next = formatVersion({ ...parsed, patch: parsed.patch + 1 });
const changelog = rotateChangelog(changelogText, next, new Date().toISOString().slice(0, 10));
pkg.version = next;
lock.version = next;
lock.packages[""].version = next;
await writeFile("package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
await writeFile("package-lock.json", `${JSON.stringify(lock, null, "\t")}\n`);
await writeFile("Changelog.md", changelog);
console.log(next);
