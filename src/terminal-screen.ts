/**
 * TerminalScreen — the rendered view of one exec_command session.
 *
 * A PTY child draws with cursor movement, erases, carriage returns and the
 * alternate screen. Stripping those controls from the raw stream leaves every
 * redraw appended to the previous one, so neither the model nor a human can
 * read the result. Each session therefore feeds its output, in order, into
 * a headless terminal emulator and reports what that terminal shows.
 *
 * Authority: the PTY byte stream (also mirrored raw to the session log). This
 * emulator is a derived projection owned by the session; it never feeds back
 * into the log.
 *
 * Observation contract (consuming, serialized per session):
 *   - normal screen: rows that scrolled into history since the previous
 *     observation and were not already reported, then the full current
 *     screen. Each observation marks the screen's top row (an xterm marker,
 *     which follows the row as it scrolls and is disposed when the row leaves
 *     the history), so the next observation's history starts at that row and
 *     lines up positionally with the previous screen. History stays in the
 *     emulator for the styled display.
 *   - alternate screen: the full screen.
 *   - nothing changed (rows, cursor, screen): `unchanged`.
 * Snapshots (partial TUI updates) and styled screens (live display) never
 * consume anything.
 *
 * Styled screens are rebuilt from cell attributes, never from child bytes:
 * the only control sequences they carry are the SGR codes written here.
 */

// @xterm/headless ships CommonJS; Node's ESM loader exposes it only as the default export.
import xtermHeadless from "@xterm/headless";
import type { IBufferCell, IMarker } from "@xterm/headless";

import type { MonitorStart } from "../fork-features/monitor-subscription.ts";

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

const CR = 0x0d;
const LF = 0x0a;
const NO_BYTES = new Uint8Array(0);

/** History budget in cells; scrollback rows = budget / cols (never below one screen). */
export const TERMINAL_HISTORY_CELLS = 240_000;

export type TerminalScreenKind = "normal" | "alternate";

export interface TerminalView {
	readonly screen: TerminalScreenKind;
	readonly cols: number;
	readonly rows: number;
	/** 1-based cursor position within the screen. */
	readonly cursor: { readonly row: number; readonly col: number };
}

export type TerminalObservation =
	| { readonly kind: "unchanged"; readonly view: TerminalView }
	| {
			readonly kind: "rendered";
			readonly view: TerminalView;
			/** History lines (if any) followed by the full current screen, trailing blank rows removed. */
			readonly text: string;
			/** Leading lines of `text` that scrolled off above the screen since the previous observation. */
			readonly historyLines: number;
			/** Rows that scrolled off since the previous observation were evicted from the capped history before being reported (see the log). */
			readonly historyMayBeTruncated: boolean;
	  };

export interface TerminalSnapshot {
	readonly view: TerminalView;
	readonly text: string;
}

export type TerminalColor =
	| { readonly kind: "default" }
	| { readonly kind: "palette"; readonly value: number }
	| { readonly kind: "rgb"; readonly value: number };

/** Copied values only: xterm reuses both its line and cell objects. */
export interface TerminalCell {
	readonly chars: string;
	readonly width: 0 | 1 | 2;
	readonly foreground: TerminalColor;
	readonly background: TerminalColor;
	readonly bold: boolean;
	readonly dim: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly inverse: boolean;
	readonly invisible: boolean;
	readonly strikethrough: boolean;
}

/** Non-consuming, immutable physical-row projection; only the active grid has styled cells. */
export interface TerminalProjection {
	readonly view: TerminalView;
	readonly retainedLines: readonly string[];
	readonly screenLines: readonly string[];
	readonly cells: readonly (readonly TerminalCell[])[];
	readonly appearance: TerminalAppearance;
	readonly historyMayBeTruncated: boolean;
}

/** The retained history and the current screen with SGR styling, one line per terminal row. */
export interface StyledScreen {
	readonly view: TerminalView;
	/** History rows, then screen rows, joined by `\n`; trailing blank rows dropped. Only SGR (`ESC [ … m`) sequences appear. */
	readonly text: string;
}

export interface TerminalLineSubscription {
	cancel(): void;
	/** Final parsed rows, before emulator disposal; false if already cancelled. */
	finish(): Promise<boolean>;
}

/** Immutable copy of one physical row; xterm reuses its line objects. */
interface Row {
	readonly text: string;
	readonly wrapped: boolean;
}

interface ObservedScreen {
	readonly screen: TerminalScreenKind;
	readonly rows: readonly Row[];
	readonly cursorRow: number;
	readonly cursorCol: number;
	/** Alternate-screen entry count when this was observed (alternate only). */
	readonly altEpoch: number;
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i]!.text !== b[i]!.text || a[i]!.wrapped !== b[i]!.wrapped) return false;
	}
	return true;
}

/**
 * Join wrapped continuation rows into logical lines; drop trailing blank lines.
 * `startedBefore` counts the logical lines that begin within the first
 * `splitRow` rows, so a line wrapping across that boundary is counted once.
 */
function toLines(rows: readonly Row[], splitRow = 0): { lines: string[]; startedBefore: number } {
	const lines: string[] = [];
	let startedBefore = 0;
	rows.forEach((row, index) => {
		if (row.wrapped && lines.length > 0) {
			lines[lines.length - 1] += row.text;
			return;
		}
		lines.push(row.text);
		if (index < splitRow) startedBefore++;
	});
	const trimmed = lines.map((line) => line.trimEnd());
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
	return { lines: trimmed, startedBefore: Math.min(startedBefore, trimmed.length) };
}

function paletteColor(color: number, base: number, brightBase: number, extended: number): string {
	if (color < 8) return String(base + color);
	if (color < 16) return String(brightBase + color - 8);
	return `${extended};5;${color}`;
}

function rgbColor(color: number, extended: number): string {
	return `${extended};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
}

/** SGR parameters for a cell's attributes; empty for the default attribute. */
function cellSgr(cell: IBufferCell): string {
	if (cell.isAttributeDefault()) return "";
	const params: string[] = [];
	if (cell.isBold()) params.push("1");
	if (cell.isDim()) params.push("2");
	if (cell.isItalic()) params.push("3");
	if (cell.isUnderline()) params.push("4");
	if (cell.isBlink()) params.push("5");
	if (cell.isInverse()) params.push("7");
	if (cell.isInvisible()) params.push("8");
	if (cell.isStrikethrough()) params.push("9");
	if (cell.isOverline()) params.push("53");
	if (cell.isFgPalette()) params.push(paletteColor(cell.getFgColor(), 30, 90, 38));
	else if (cell.isFgRGB()) params.push(rgbColor(cell.getFgColor(), 38));
	if (cell.isBgPalette()) params.push(paletteColor(cell.getBgColor(), 40, 100, 48));
	else if (cell.isBgRGB()) params.push(rgbColor(cell.getBgColor(), 48));
	return params.join(";");
}

/** Whether the surface showing a screen is light or dark. */
export type TerminalAppearance = "dark" | "light";

/** OSC 10/11 answers (default foreground, background) per appearance, in xterm's `rgb:` form. */
const DEFAULT_COLORS: Readonly<Record<TerminalAppearance, { readonly fg: string; readonly bg: string }>> = {
	dark: { fg: "rgb:ffff/ffff/ffff", bg: "rgb:0000/0000/0000" },
	light: { fg: "rgb:0000/0000/0000", bg: "rgb:ffff/ffff/ffff" },
};

/** A cell that draws nothing: blank glyph on the default background, not inverted. */
function isBlankCell(cell: IBufferCell): boolean {
	const chars = cell.getChars();
	return (chars === "" || chars === " ") && cell.isBgDefault() && !cell.isInverse();
}

export class TerminalScreen {
	readonly cols: number;
	readonly rows: number;
	private readonly scrollback: number;
	private readonly term: Terminal;
	/** Writes handed to xterm whose parse callback has not fired yet. */
	private pendingWrites = 0;
	private flushWaiters: Array<() => void> = [];
	/** Serializes consuming observations. */
	private observeChain: Promise<unknown> = Promise.resolve();
	private altEpoch = 0;
	private lastNormal: ObservedScreen | undefined;
	private lastAlt: ObservedScreen | undefined;
	private lastScreen: TerminalScreenKind | undefined;
	/** Normal-screen row that was the top of the last observed normal screen. */
	private observedTop: IMarker | undefined;
	private disposed = false;
	/** Notified after each child write is parsed into the screen. */
	private readonly changeListeners = new Set<() => void>();
	/**
	 * Notified right after a carriage return that is not part of CR LF has
	 * been parsed, before the bytes that overwrite its row. Only while a
	 * listener exists are child writes split at those points.
	 */
	private readonly carriageReturnListeners = new Set<() => void>();
	/** The last child byte was CR; whether it starts an overwrite depends on the next write. */
	private pendingCarriageReturn = false;
	private readonly appearance: () => TerminalAppearance;

	/**
	 * @param reply receives the terminal's own responses to queries (cursor
	 *   position, device attributes, default colors), which a real terminal
	 *   sends back to the child.
	 * @param appearance the background the screen is shown on, read at each
	 *   OSC 10/11 query: programs such as omp pick their light or dark palette
	 *   from the answer, and xterm answers neither query itself.
	 */
	constructor(
		cols: number,
		rows: number,
		reply: (bytes: Uint8Array) => void,
		appearance: () => TerminalAppearance = () => "dark",
	) {
		this.cols = cols;
		this.rows = rows;
		this.appearance = appearance;
		this.scrollback = Math.max(rows, Math.floor(TERMINAL_HISTORY_CELLS / cols));
		this.term = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true });
		const encoder = new TextEncoder();
		this.term.onData((data) => reply(encoder.encode(data)));
		// Answered inside the parse, so the reply precedes that of a DA1 sent after the query (omp's sentinel).
		for (const [osc, slot] of [[10, "fg"], [11, "bg"]] as const) {
			this.term.parser.registerOscHandler(osc, (data) => {
				if (data !== "?") return false;
				reply(encoder.encode(`\x1b]${osc};${DEFAULT_COLORS[appearance()][slot]}\x07`));
				return true;
			});
		}
		this.term.buffer.onBufferChange((buffer) => {
			if (buffer.type === "alternate") this.altEpoch++;
		});
	}

	/** Feed child output, in arrival order. */
	write(chunk: Uint8Array): void {
		if (this.disposed) return;
		if (chunk.length === 0) return;
		const pending = this.pendingCarriageReturn;
		this.pendingCarriageReturn = chunk[chunk.length - 1] === CR;
		if (this.carriageReturnListeners.size === 0) {
			this.enqueue(chunk, this.notifyChange);
			return;
		}
		// A bare CR returns the cursor to the start of its row, so the next
		// bytes overwrite it. Sample the row in between; CR LF moves to a new
		// row and needs no sample. Splitting a write keeps xterm's parser state.
		if (pending && chunk[0] !== LF && chunk[0] !== CR) this.enqueue(NO_BYTES, this.notifyCarriageReturn);
		let start = 0;
		for (let index = 0; index + 1 < chunk.length; index++) {
			if (chunk[index] !== CR || chunk[index + 1] === LF || chunk[index + 1] === CR) continue;
			this.enqueue(chunk.subarray(start, index + 1), this.notifyCarriageReturn);
			start = index + 1;
		}
		this.enqueue(chunk.subarray(start), this.notifyChange);
	}

	/** Call `listener` each time a child write finishes parsing from now on (even one queued earlier); returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private readonly notifyChange = (): void => {
		for (const listener of this.changeListeners) listener();
	};

	private readonly notifyCarriageReturn = (): void => {
		for (const listener of this.carriageReturnListeners) listener();
	};

	private enqueue(data: Uint8Array | string, parsed?: () => void): void {
		this.pendingWrites++;
		this.term.write(data, () => {
			this.pendingWrites--;
			if (this.pendingWrites === 0) {
				const waiters = this.flushWaiters;
				this.flushWaiters = [];
				for (const resolve of waiters) resolve();
			}
			parsed?.();
		});
	}

	/** Resolves once every write so far has been parsed into the screen. */
	private flushed(): Promise<void> {
		if (this.pendingWrites === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.flushWaiters.push(resolve);
		return promise;
	}

	private view(): TerminalView {
		const buffer = this.term.buffer.active;
		return {
			screen: buffer.type,
			cols: this.cols,
			rows: this.rows,
			cursor: { row: buffer.cursorY + 1, col: Math.min(buffer.cursorX, this.cols - 1) + 1 },
		};
	}

	private readRows(kind: TerminalScreenKind, start: number, end: number): Row[] {
		const buffer = kind === "normal" ? this.term.buffer.normal : this.term.buffer.alternate;
		const rows: Row[] = [];
		for (let y = start; y < end; y++) {
			const line = buffer.getLine(y);
			rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
		}
		return rows;
	}

	/** Current screen as a human sees it now, without consuming anything. May lag unparsed output. */
	snapshot(): TerminalSnapshot {
		const buffer = this.term.buffer.active;
		const rows = this.readRows(buffer.type, buffer.baseY, buffer.baseY + this.rows);
		return { view: this.view(), text: toLines(rows).lines.join("\n") };
	}

	/**
	 * Copy a fully parsed projection without changing any observation marker.
	 * Reads and disposal share the observation chain so no reader outlives xterm.
	 */
	project(): Promise<TerminalProjection> {
		const run = this.observeChain.then(async () => {
			if (this.disposed) throw new Error("terminal screen read after release");
			// An ordered barrier covers writes already accepted without waiting for a
			// continuously producing child to become globally idle.
			await new Promise<void>((resolve) => this.term.write("", resolve));
			const normal = this.term.buffer.normal;
			const active = this.term.buffer.active;
			const physicalLines = (kind: TerminalScreenKind, start: number, end: number): readonly string[] => {
				const lines = this.readRows(kind, start, end).map((row) => row.text.trimEnd());
				while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
				return Object.freeze(lines);
			};
			const cell = active.getNullCell();
			const cells: TerminalCell[][] = [];
			for (let y = 0; y < this.rows; y++) {
				const line = active.getLine(active.baseY + y);
				const row: TerminalCell[] = [];
				for (let x = 0; x < this.cols; x++) {
					if (!line?.getCell(x, cell)) continue;
					const foreground: TerminalColor = cell.isFgPalette()
						? { kind: "palette", value: cell.getFgColor() }
						: cell.isFgRGB() ? { kind: "rgb", value: cell.getFgColor() } : { kind: "default" };
					const background: TerminalColor = cell.isBgPalette()
						? { kind: "palette", value: cell.getBgColor() }
						: cell.isBgRGB() ? { kind: "rgb", value: cell.getBgColor() } : { kind: "default" };
					const width = cell.getWidth();
					if (width !== 0 && width !== 1 && width !== 2) throw new Error(`unexpected terminal cell width: ${width}`);
					row.push(Object.freeze({
						chars: cell.getChars(),
						width,
						foreground: Object.freeze(foreground),
						background: Object.freeze(background),
						bold: Boolean(cell.isBold()),
						dim: Boolean(cell.isDim()),
						italic: Boolean(cell.isItalic()),
						underline: Boolean(cell.isUnderline()),
						inverse: Boolean(cell.isInverse()),
						invisible: Boolean(cell.isInvisible()),
						strikethrough: Boolean(cell.isStrikethrough()),
					}));
				}
				cells.push(row);
			}
			const view = this.view();
			return Object.freeze({
				view: Object.freeze({ ...view, cursor: Object.freeze(view.cursor) }),
				retainedLines: physicalLines("normal", 0, normal.baseY + this.rows),
				screenLines: physicalLines(active.type, active.baseY, active.baseY + this.rows),
				cells: Object.freeze(cells.map((row) => Object.freeze(row))),
				appearance: this.appearance(),
				historyMayBeTruncated: normal.baseY >= this.scrollback,
			});
		});
		this.observeChain = run.catch(() => undefined);
		return run;
	}
	/**
	 * The retained history and the current screen, each row's colors and
	 * attributes as SGR, without consuming anything. The alternate screen has
	 * no history. May lag unparsed output. Must not be called after release.
	 */
	styledScreen(): StyledScreen {
		const buffer = this.term.buffer.active;
		const cell = buffer.getNullCell();
		const lines: string[] = [];
		for (let y = 0; y < buffer.baseY + this.rows; y++) {
			const line = buffer.getLine(y);
			if (!line) {
				lines.push("");
				continue;
			}
			let end = 0;
			for (let x = 0; x < this.cols; x++) {
				if (line.getCell(x, cell) && !isBlankCell(cell)) end = x + 1;
			}
			let out = "";
			let current = "";
			for (let x = 0; x < end; x++) {
				if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
				const sgr = cellSgr(cell);
				if (sgr !== current) {
					out += sgr === "" ? "\x1b[0m" : `\x1b[0;${sgr}m`;
					current = sgr;
				}
				out += cell.getChars() || " ";
			}
			lines.push(current === "" ? out : `${out}\x1b[0m`);
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return { view: this.view(), text: lines.join("\n") };
	}

	/** Atomic future-only baseline and an independent positional row cursor. */
	subscribeLines(
		isRunning: () => boolean,
		onLines: (lines: readonly string[]) => void,
		accept: (handle: TerminalLineSubscription) => boolean,
		signal?: AbortSignal,
	): Promise<MonitorStart> {
		const run = this.observeChain.then(async (): Promise<MonitorStart> => {
			await new Promise<void>((resolve) => this.term.write("", resolve));
			if (signal?.aborted || this.disposed) return "cancelled";
			if (!isRunning()) return "not_running";
			let active = true;
			interface MarkedRow { readonly row: Row; readonly marker: IMarker }
			interface NormalCursor { readonly rows: readonly MarkedRow[]; readonly frontier: IMarker | undefined }
			const logicalStart = (): number => {
				const buffer = this.term.buffer.normal;
				let start = buffer.baseY;
				while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
				return start;
			};
			const markerAt = (line: number): IMarker => {
				const buffer = this.term.buffer.normal;
				const marker = this.term.registerMarker(line - buffer.baseY - buffer.cursorY);
				if (!marker) throw new Error("normal terminal monitor marker unavailable");
				return marker;
			};
			const capture = (start: number, rows: readonly Row[], prior: ReadonlyMap<number, MarkedRow>, old?: NormalCursor): NormalCursor => {
				const frontierLine = start - 1;
				const frontier = old?.frontier && !old.frontier.isDisposed && old.frontier.line === frontierLine
					? old.frontier : frontierLine >= 0 ? markerAt(frontierLine) : undefined;
				if (old?.frontier !== frontier) old?.frontier?.dispose();
				const marked = rows.map((row, index): MarkedRow => {
					const previous = prior.get(start + index);
					return { row, marker: previous?.marker ?? markerAt(start + index) };
				});
				for (const [line, previous] of prior) {
					if (line < start || line >= start + rows.length) previous.marker.dispose();
				}
				return { rows: marked, frontier };
			};
			const baseline = (): NormalCursor => {
				const start = logicalStart();
				return capture(start, this.readRows("normal", start, this.term.buffer.normal.baseY + this.rows), new Map());
			};
			let normal = this.term.buffer.active.type === "normal" ? baseline() : undefined;
			let previousAlt = this.readRows("alternate", 0, this.rows);
			let previousEpoch = this.altEpoch;
			const disposeNormal = () => {
				normal?.frontier?.dispose();
				for (const row of normal?.rows ?? []) row.marker.dispose();
			};
			// RIS replaces xterm's underlying normal buffer, while its public
			// BufferApiView object stays identical. Invalidate this cursor at
			// that authoritative parser boundary, not by guessing from row text.
			const reset = this.term.parser.registerEscHandler({ final: "c" }, () => {
				disposeNormal();
				normal = undefined;
				previousAlt = [];
				return false;
			});
			// Normal markers cannot be created while alternate is active.
			const bufferSwitch = this.term.buffer.onBufferChange((buffer) => {
				if (buffer.type === "normal" && normal === undefined) normal = baseline();
			});
			const changedLines = (rows: readonly Row[], changed: readonly boolean[]): string[] => {
				const lines: string[] = [];
				for (let start = 0; start < rows.length;) {
					let end = start + 1;
					while (end < rows.length && rows[end]!.wrapped) end++;
					let dirty = false;
					for (let index = start; index < end; index++) dirty ||= changed[index]!;
					if (dirty) {
						const parts: string[] = [];
						for (let index = start; index < end; index++) parts.push(rows[index]!.text);
						lines.push(parts.join("").trimEnd());
					}
					start = end;
				}
				return lines;
			};
			let quiet: NodeJS.Timeout | undefined;
			let maximum: NodeJS.Timeout | undefined;
			const clearTimers = () => {
				clearTimeout(quiet);
				clearTimeout(maximum);
				quiet = maximum = undefined;
			};
			const drain = (): Promise<void> => {
				const reading = this.observeChain.then(async () => {
					if (!active) return;
					await new Promise<void>((resolve) => this.term.write("", resolve));
					if (!active) return;
					const buffer = this.term.buffer.active;
					let changed: string[];
					if (buffer.type === "alternate") {
						const rows = this.readRows("alternate", 0, this.rows);
						changed = changedLines(rows, rows.map((row, index) =>
							row.text.trimEnd() !== (previousAlt[index]?.text.trimEnd() ?? "") || row.wrapped !== (previousAlt[index]?.wrapped ?? false) ||
							(previousEpoch !== this.altEpoch && row.text.trimEnd() !== "")));
						previousAlt = rows;
						previousEpoch = this.altEpoch;
					} else {
						const prior = new Map<number, MarkedRow>();
						for (const row of normal?.rows ?? []) if (!row.marker.isDisposed) prior.set(row.marker.line, row);
						const frontier = normal?.frontier;
						const start = frontier && !frontier.isDisposed ? frontier.line + 1 : 0;
						const rows = this.readRows("normal", start, buffer.baseY + this.rows);
						const oldScreenStart = (normal?.rows.length ?? 0) - this.rows;
						const differences = rows.map((row, index) => {
							const line = start + index;
							// Live markers preserve physical identity across scroll/trim.
							// Erase/redraw disposes markers: compare the same viewport
							// position while a surviving history frontier fixes its origin.
							const positional = normal?.rows[oldScreenStart + line - buffer.baseY];
							const previous = prior.get(line)?.row ??
								(line >= buffer.baseY && positional?.marker.isDisposed && ((frontier && !frontier.isDisposed) || buffer.baseY === 0)
									? positional.row : undefined);
							if (previous) return row.text !== previous.text || row.wrapped !== previous.wrapped;
							// Unwritten padding below the cursor is not a new output line.
							return row.text.trimEnd() !== "" || line <= buffer.baseY + buffer.cursorY;
						});
						changed = changedLines(rows, differences);
						const nextStart = logicalStart();
						normal = capture(nextStart, rows.slice(nextStart - start), prior, normal);
					}
					if (changed.length) onLines(changed);
				});
				this.observeChain = reading.catch(() => undefined);
				return reading;
			};
			const evaluate = () => {
				clearTimers();
				void drain();
			};
			const unsubscribe = this.onChange(() => {
				clearTimeout(quiet);
				quiet = setTimeout(evaluate, 50);
				maximum ??= setTimeout(evaluate, 250);
			});
			// A full-screen program (tmux, a remote shell inside it) may draw a
			// line and overwrite it after a bare CR within one drain window. The
			// row is read from the parsed buffer at that boundary and recorded
			// as reported, so the next drain does not repeat it. Normal-screen
			// rows keep their marker identities and are not sampled here.
			const sampleCarriageReturn = () => {
				if (!active) return;
				const buffer = this.term.buffer.active;
				if (buffer.type !== "alternate") return;
				if (previousEpoch !== this.altEpoch) {
					previousAlt = [];
					previousEpoch = this.altEpoch;
				}
				let start = buffer.cursorY;
				while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
				let end = buffer.cursorY + 1;
				while (end < this.rows && buffer.getLine(end)?.isWrapped) end++;
				const rows = this.readRows("alternate", start, end);
				const changed = rows.some((row, index) =>
					row.text.trimEnd() !== (previousAlt[start + index]?.text.trimEnd() ?? "") ||
					row.wrapped !== (previousAlt[start + index]?.wrapped ?? false));
				if (!changed) return;
				rows.forEach((row, index) => { previousAlt[start + index] = row; });
				onLines([rows.map((row) => row.text).join("").trimEnd()]);
			};
			const carriageReturnListeners = this.carriageReturnListeners;
			carriageReturnListeners.add(sampleCarriageReturn);
			const handle: TerminalLineSubscription = {
				cancel() {
					active = false;
					clearTimers();
					unsubscribe();
					carriageReturnListeners.delete(sampleCarriageReturn);
					bufferSwitch.dispose();
					reset.dispose();
					disposeNormal();
				},
				async finish() {
					clearTimers();
					unsubscribe();
					// Every accepted byte, including its CR samples, parses before this drain ends.
					await drain();
					carriageReturnListeners.delete(sampleCarriageReturn);
					bufferSwitch.dispose();
					if (!active) return false;
					active = false;
					reset.dispose();
					disposeNormal();
					return true;
				},
			};
			try {
				if (!accept(handle)) { handle.cancel(); return "cancelled"; }
			} catch (error) {
				handle.cancel();
				throw error;
			}
			return "accepted";
		});
		this.observeChain = run.catch(() => undefined);
		return run;
	}

	/** Consuming observation; serialized so concurrent callers never share or skip a boundary. */
	observe(): Promise<TerminalObservation> {
		const run = this.observeChain.then(() => this.observeNow());
		this.observeChain = run.catch(() => undefined);
		return run;
	}

	private async observeNow(): Promise<TerminalObservation> {
		if (this.disposed) throw new Error("terminal screen observed after release");
		await new Promise<void>((resolve) => this.term.write("", resolve));
		const view = this.view();
		const buffer = this.term.buffer.active;

		if (buffer.type === "alternate") {
			const rows = this.readRows("alternate", 0, this.rows);
			const current: ObservedScreen = {
				screen: "alternate",
				rows,
				cursorRow: view.cursor.row,
				cursorCol: view.cursor.col,
				altEpoch: this.altEpoch,
			};
			const previous = this.lastScreen === "alternate" ? this.lastAlt : undefined;
			this.lastAlt = current;
			this.lastScreen = "alternate";
			if (
				previous &&
				previous.altEpoch === current.altEpoch &&
				previous.cursorRow === current.cursorRow &&
				previous.cursorCol === current.cursorCol &&
				sameRows(previous.rows, rows)
			) {
				return { kind: "unchanged", view };
			}
			return {
				kind: "rendered",
				view,
				text: toLines(rows).lines.join("\n"),
				historyLines: 0,
				historyMayBeTruncated: false,
			};
		}

		const baseY = buffer.baseY;
		const top = this.observedTop;
		const start = top && !top.isDisposed ? Math.min(top.line, baseY) : 0;
		const history = this.readRows("normal", start, baseY);
		const screen = this.readRows("normal", baseY, baseY + this.rows);
		const previous = this.lastNormal;
		const returningFromAlt = this.lastScreen === "alternate";
		this.lastNormal = { screen: "normal", rows: screen, cursorRow: view.cursor.row, cursorCol: view.cursor.col, altEpoch: 0 };
		this.lastScreen = "normal";

		// History rows from the marked row line up with the previous screen's
		// rows. Skip the prefix already reported unchanged; never start inside a
		// wrapped logical line.
		const priorRows = previous?.rows ?? [];
		let skip = 0;
		while (
			skip < history.length &&
			skip < priorRows.length &&
			history[skip]!.text === priorRows[skip]!.text &&
			history[skip]!.wrapped === priorRows[skip]!.wrapped
		) {
			skip++;
		}
		// The row at `skip` is the next one reported (history first, then the
		// screen); back up while it continues a line whose start was skipped.
		while (skip > 0 && (skip < history.length ? history[skip]! : screen[0])?.wrapped) skip--;
		const newHistory = history.slice(skip);
		// Rows were evicted only if the marked row is gone while the history is
		// at its cap; a child's ED3 or RIS also drops the marker, but then the
		// child erased those rows itself.
		const historyMayBeTruncated = (top === undefined || top.isDisposed) && baseY >= this.scrollback;

		// Mark this screen's top row for the next observation.
		top?.dispose();
		this.observedTop = this.term.registerMarker(-buffer.cursorY);

		if (
			previous &&
			!returningFromAlt &&
			newHistory.length === 0 &&
			previous.cursorRow === view.cursor.row &&
			previous.cursorCol === view.cursor.col &&
			sameRows(previous.rows, screen)
		) {
			return { kind: "unchanged", view };
		}
		const { lines, startedBefore } = toLines([...newHistory, ...screen], newHistory.length);
		return {
			kind: "rendered",
			view,
			text: lines.join("\n"),
			historyLines: startedBefore,
			historyMayBeTruncated,
		};
	}

	/** Release after all previously queued reads and observations finish. Idempotent. */
	release(): Promise<void> {
		this.changeListeners.clear();
		const run = this.observeChain.then(async () => {
			if (this.disposed) return;
			await this.flushed();
			this.disposed = true;
			this.term.dispose();
		});
		this.observeChain = run.catch(() => undefined);
		return run;
	}
}
