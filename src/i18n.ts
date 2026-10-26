export type Language = "en" | "zh";

export const LANGUAGE_ENV = "OMOMP_LANG";

function parseLanguage(value: string | undefined): Language | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

/** Resolve the UI language from the launch environment each time it is needed. */
export function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit) return explicit;

	for (const value of [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]) {
		const locale = value?.trim();
		if (locale) return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** Select the person-facing translation at the call site. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
