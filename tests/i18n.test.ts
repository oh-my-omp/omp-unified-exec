import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LANGUAGE_ENV, language } from "../src/i18n.ts";

const LANGUAGE_KEYS = [LANGUAGE_ENV, "LC_ALL", "LC_MESSAGES", "LANG"] as const;

describe("environment-only UI language", () => {
	it("resolves explicit language before locale fallback in call-time order", () => {
		const previous = Object.fromEntries(LANGUAGE_KEYS.map((key) => [key, process.env[key]]));
		try {
			for (const key of LANGUAGE_KEYS) delete process.env[key];
			process.env.LC_ALL = "en_US.UTF-8";
			process.env.LC_MESSAGES = "zh_CN.UTF-8";
			process.env.LANG = "zh_TW.UTF-8";
			assert.equal(language(), "en");

			process.env.OMOMP_LANG = "  ZH  ";
			assert.equal(language(), "zh");

			process.env.OMOMP_LANG = "fr";
			assert.equal(language(), "en");

			process.env.LC_ALL = " ";
			assert.equal(language(), "zh");

			delete process.env.LC_MESSAGES;
			assert.equal(language(), "zh");

			for (const key of LANGUAGE_KEYS) delete process.env[key];
			assert.equal(language(), "en");
		} finally {
			for (const key of LANGUAGE_KEYS) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
