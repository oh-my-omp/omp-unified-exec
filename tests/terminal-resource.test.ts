import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { freezeTerminal, parseTerminalTarget, readTerminal, registerTerminal, terminalText } from "../fork-features/terminal-resource.ts";
import { TerminalScreen } from "../src/terminal-screen.ts";

const encoder = new TextEncoder();

describe("non-consuming terminal resources", () => {
	it("pages physical rows without consuming the next history observation", async (t) => {
		const screen = new TerminalScreen(5, 2, () => {});
		t.after(() => screen.release());
		screen.write(encoder.encode("abcdefghij\r\nnext\r\nlast"));
		const projection = await screen.project();
		assert.deepEqual(projection.retainedLines, ["abcde", "fghij", "next", "last"]);
		assert.equal(terminalText(projection, parseTerminalTarget("/page/1")), "abcde\nfghij");
		assert.equal(terminalText(projection, parseTerminalTarget("/page/-1")), "next\nlast");
		assert.throws(() => terminalText(projection, parseTerminalTarget("/page/3")), /terminal_page_out_of_range.*2 total pages/);
		const observation = await screen.observe();
		assert.equal(observation.kind, "rendered");
		if (observation.kind === "rendered") assert.equal(observation.text, "abcdefghij\nnext\nlast");
	});

	it("keeps normal history separate from the alternate screen and deep-copies styled cells", async (t) => {
		const screen = new TerminalScreen(10, 2, () => {});
		t.after(() => screen.release());
		screen.write(encoder.encode("normal\x1b[?1049h\x1b[H\x1b[31m中文AB"));
		const projection = await screen.project();
		assert.deepEqual(projection.retainedLines, ["normal"]);
		assert.deepEqual(projection.screenLines, ["中文AB"]);
		assert.equal(projection.view.screen, "alternate");
		assert.deepEqual(projection.cells[0]![0]!.foreground, { kind: "palette", value: 1 });
		assert.equal(projection.cells[0]![0]!.width, 2);
		assert.equal(projection.cells[0]![1]!.width, 0);
		screen.write(encoder.encode("\r\x1b[2Kchanged"));
		await screen.project();
		assert.deepEqual(projection.screenLines, ["中文AB"]);
		assert.equal(projection.cells[0]![0]!.chars, "中");
	});

	it("reads what a human sees: the alternate screen while it is active, normal history after it", async (t) => {
		const screen = new TerminalScreen(10, 2, () => {});
		t.after(() => screen.release());
		screen.write(encoder.encode("before\r\nprompt\x1b[?1049h\x1b[Htmux pane\r\nstatus"));
		const alternate = await screen.project();
		assert.equal(terminalText(alternate, parseTerminalTarget("")), "tmux pane\nstatus");
		assert.equal(terminalText(alternate, parseTerminalTarget("/page/-1")), "tmux pane\nstatus");
		assert.equal(terminalText(alternate, parseTerminalTarget("/screen")), "tmux pane\nstatus");
		screen.write(encoder.encode("\x1b[?1049l\r\nafter"));
		const normal = await screen.project();
		assert.equal(terminalText(normal, parseTerminalTarget("")), "before\nprompt\nafter");
	});

	it("retains distinct same-number resources after freeze and parser disposal", async () => {
		const first = new TerminalScreen(10, 2, () => {});
		const second = new TerminalScreen(10, 2, () => {});
		try {
			const a = registerTerminal(1, first);
			const b = registerTerminal(1, second);
			assert.notEqual(a, b);
			first.write(encoder.encode("first"));
			second.write(encoder.encode("second"));
			await freezeTerminal(a);
			await freezeTerminal(b);
			await first.release();
			await second.release();
			assert.deepEqual((await readTerminal(a)).retainedLines, ["first"]);
			assert.deepEqual((await readTerminal(b)).retainedLines, ["second"]);
			await assert.rejects(readTerminal("missing-terminal"), /unknown_terminal/);
		} finally {
			await first.release();
			await second.release();
		}
	});
});
