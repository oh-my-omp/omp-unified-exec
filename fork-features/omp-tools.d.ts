// Ambient script (no top-level import/export): these modules exist only inside
// oh-my-pi, so their values are parsed at runtime by omp-presentation.ts and
// tern-terminal-hud.ts.
declare module "@oh-my-pi/pi-tui/tools" {
	export const toolRenderers: Readonly<Record<string, unknown>>;
}

declare module "@oh-my-pi/pi-tui/native/state" {
	export const isNativeRendering: unknown;
	export const onNativeRenderingChange: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/modes/interactive-mode" {
	export const InteractiveMode: unknown;
}

declare module "@oh-my-pi/pi-tui/theme" {
	export const isLightTheme: unknown;
	export const getCurrentThemeName: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/internal-urls" {
	export const InternalUrlRouter: unknown;
}

declare module "@oh-my-pi/pi-natives" {
	export function rasterizeSvg(input: Uint8Array, maxWidthPx: number, maxHeightPx: number): Promise<Uint8Array>;
}

declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export const lookup: unknown;
}

declare module "@oh-my-pi/pi-coding-agent" {
	export const AgentRegistry: unknown;
	export const CRITICAL_BASH_PATTERNS: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/exec/settings" {
	export const cfgBashPatterns: unknown;
	export const cfgBashAllowCompoundCommands: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/shell-tokenize" {
	export const tokenizeShellSegments: unknown;
	export const extractLiteralAndChainSegments: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/approval" {
	export const truncateForPrompt: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation" {
	export const invalidateGithubCacheForBashCommand: unknown;
}
