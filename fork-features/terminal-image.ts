import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TerminalColor, TerminalProjection } from "../src/terminal-screen.ts";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const MAX_PIXELS = 16 * 1024 * 1024;
const ANSI_COLORS = [
	"#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
	"#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
] as const;

function hex(value: number): string {
	return `#${value.toString(16).padStart(6, "0")}`;
}

function color(value: TerminalColor, fallback: string): string {
	switch (value.kind) {
		case "default": return fallback;
		case "rgb": return hex(value.value);
		case "palette": {
			const index = value.value;
			if (index < 16) return ANSI_COLORS[index]!;
			if (index >= 232) {
				const grey = 8 + (index - 232) * 10;
				return hex(grey * 0x010101);
			}
			const cube = index - 16;
			const level = (n: number): number => n === 0 ? 0 : 55 + 40 * n;
			return hex((level(Math.floor(cube / 36)) << 16) | (level(Math.floor(cube / 6) % 6) << 8) | level(cube % 6));
		}
	}
}

/** xterm glyphs are data, never SVG markup or XML-invalid code points. */
function xmlText(text: string): string {
	return text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Pure projection of the copied active grid. No child bytes, SGR, history or external assets. */
export function terminalSvg(projection: TerminalProjection, live: boolean): string {
	const { cols, rows, cursor } = projection.view;
	const width = cols * CELL_WIDTH;
	const height = rows * CELL_HEIGHT;
	const foreground = projection.appearance === "light" ? "#000000" : "#ffffff";
	const background = projection.appearance === "light" ? "#ffffff" : "#000000";
	const backgrounds: string[] = [];
	const glyphs: string[] = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const cell = projection.grid.cell(row, col)!;
			const x = col * CELL_WIDTH;
			const y = row * CELL_HEIGHT;
			let fg = color(cell.foreground, foreground);
			let bg = color(cell.background, background);
			if (cell.inverse) [fg, bg] = [bg, fg];
			if (bg !== background) backgrounds.push(`<rect x="${x}" y="${y}" width="8" height="16" fill="${bg}"/>`);
			if (cell.width === 0 || cell.invisible) continue;
			const span = cell.width * CELL_WIDTH;
			const opacity = cell.dim ? ' opacity="0.5"' : "";
			if (cell.chars && cell.chars !== " ") {
				const weight = cell.bold ? ' font-weight="bold"' : "";
				const italic = cell.italic ? ' font-style="italic"' : "";
				glyphs.push(`<text x="${x}" y="${y + 13}" fill="${fg}"${opacity}${weight}${italic} textLength="${span}" lengthAdjust="spacingAndGlyphs">${xmlText(cell.chars)}</text>`);
			}
			if (cell.underline) glyphs.push(`<path d="M${x} ${y + 15}h${span}" stroke="${fg}"${opacity}/>`);
			if (cell.strikethrough) glyphs.push(`<path d="M${x} ${y + 8}h${span}" stroke="${fg}"${opacity}/>`);
		}
	}
	const caret = live ? `<rect x="${(cursor.col - 1) * CELL_WIDTH + 0.5}" y="${(cursor.row - 1) * CELL_HEIGHT + 0.5}" width="7" height="15" fill="none" stroke="${foreground}"/>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${background}"/><g>${backgrounds.join("")}</g><g font-family="monospace" font-size="14" xml:space="preserve">${glyphs.join("")}</g>${caret}</svg>`;
}

/** Each read gets a private immutable file; the host opens it after locate returns. */
export async function writeTerminalImage(projection: TerminalProjection, live: boolean): Promise<string> {
	const { rasterizeSvg } = await import("@oh-my-pi/pi-natives");
	const width = projection.view.cols * CELL_WIDTH;
	const height = projection.view.rows * CELL_HEIGHT;
	const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
	const png = await rasterizeSvg(new TextEncoder().encode(terminalSvg(projection, live)), Math.floor(width * scale), Math.floor(height * scale));
	// No overwrite race between concurrent reads, and no image cache standing in
	// for the terminal. Like session logs, these files rely on OS temp cleanup.
	const directory = await mkdtemp(join(tmpdir(), "omp-terminal-image-"));
	const path = join(directory, "screen.png");
	try {
		await writeFile(path, png, { mode: 0o600, flag: "wx" });
		return path;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
