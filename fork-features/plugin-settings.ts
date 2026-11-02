/**
 * The plugin's host-native settings (`omp.settings` in package.json), edited
 * in omp's /settings → Plugins or `omp plugin config`. omp's
 * `getPluginSettings` merges the global values with the project's overrides
 * and applies no defaults, so the manifest default is applied here. Values
 * are read when used, so a change applies without a restart.
 */
import manifest from "../package.json";

export const PLUGIN_NAME = "omp-unified-exec";

/** omp's `getPluginSettings` bound to this plugin: the merged stored values for a working directory. */
export type PluginSettingsReader = (cwd: string) => Promise<Readonly<Record<string, unknown>>>;

export const GRACE_RECLAIM_KEY = "notice.graceReclaim";

export type SettingRead<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly key: string; readonly fallback: T };

/** `notice.graceReclaim`: whether a reclaim after the reclaim-due grace sends a notice. */
export function parseGraceReclaim(settings: Readonly<Record<string, unknown>>): SettingRead<boolean> {
	const fallback = manifest.omp.settings[GRACE_RECLAIM_KEY].default;
	const raw = settings[GRACE_RECLAIM_KEY];
	if (raw === undefined) return { kind: "ok", value: fallback };
	return typeof raw === "boolean" ? { kind: "ok", value: raw } : { kind: "invalid", key: GRACE_RECLAIM_KEY, fallback };
}

/** Load omp's plugin settings API before any tool registers; a reshaped omp fails plugin loading. */
export async function loadPluginSettingsReader(): Promise<PluginSettingsReader> {
	// Dynamic: omp supplies this host-only subpath at extension load time; the dev dependencies do not have it.
	const module: unknown = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
	if (typeof module !== "object" || module === null ||
		!("getPluginSettings" in module) || typeof module.getPluginSettings !== "function") {
		throw new Error("omp-unified-exec: extensibility/plugins/loader lacks getPluginSettings");
	}
	// Checked as a function above; its signature is omp's and has no runtime check.
	const getPluginSettings = module.getPluginSettings as (plugin: string, cwd: string) => Promise<unknown>;
	return async (cwd) => {
		const value = await getPluginSettings(PLUGIN_NAME, cwd);
		if (typeof value !== "object" || value === null) throw new Error("omp-unified-exec: getPluginSettings returned no settings object");
		// A non-null object; its values stay `unknown` and are parsed per key.
		return value as Readonly<Record<string, unknown>>;
	};
}
