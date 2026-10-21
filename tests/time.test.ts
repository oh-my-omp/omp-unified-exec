import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nowUtcIso } from "../src/format-time.ts";

const NOW = Date.UTC(2026, 6, 21, 8, 30, 0, 0); // 2026-07-21T08:30:00.000Z

describe("nowUtcIso", () => {
	it("formats the injected instant as ISO UTC", () => {
		assert.equal(nowUtcIso(NOW), "2026-07-21T08:30:00.000Z");
	});
});
