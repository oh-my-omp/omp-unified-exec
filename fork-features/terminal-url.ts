import { sanitizeOutputText } from "../src/output-safety.ts";
import { writeTerminalImage } from "./terminal-image.ts";
import { getTerminalResource, noteTerminalRead, parseTerminalTarget, readTerminal, terminalText } from "./terminal-resource.ts";

const handlerBrand = Symbol.for("omp-unified-exec.term-handler");

interface TerminalUrlHandler {
	readonly [handlerBrand]: true;
	readonly scheme: "term";
	readonly spec: { readonly backing: "file"; readonly selectors: "lines"; readonly immutable: false };
	resolve(url: URL): Promise<{ url: string; content: string; contentType: "text/plain"; immutable: false }>;
	locate(url: URL): Promise<string | null>;
}

interface TerminalUrlRouter {
	register(handler: TerminalUrlHandler): void;
	getHandler(scheme: string): unknown;
}

/** The router owns registration; reload refreshes our one handler object in place. */
export async function initializeTerminalUrls(): Promise<void> {
	// This host-only subpath does not exist in the Node/Pi development runtime.
	const module = await import("@oh-my-pi/pi-coding-agent/internal-urls");
	const Router = module.InternalUrlRouter as { instance?: unknown } | undefined;
	if (!Router || typeof Router.instance !== "function") {
		throw new Error("omp-unified-exec: internal-urls lacks InternalUrlRouter.instance; requalify term:// integration");
	}
	const router: unknown = Router.instance();
	if (typeof router !== "object" || router === null || !("register" in router) || typeof router.register !== "function" ||
		!("getHandler" in router) || typeof router.getHandler !== "function") {
		throw new Error("omp-unified-exec: InternalUrlRouter lacks register/getHandler; requalify term:// integration");
	}
	const handler: TerminalUrlHandler = {
		[handlerBrand]: true,
		scheme: "term",
		spec: { backing: "file", selectors: "lines", immutable: false },
		async resolve(url) {
			const projection = await readTerminal(url.hostname);
			const target = parseTerminalTarget(url.pathname);
			const content = sanitizeOutputText(terminalText(projection, target));
			noteTerminalRead(url.hostname);
			return { url: url.href, content, contentType: "text/plain", immutable: false };
		},
		async locate(url) {
			if (url.pathname !== "/screen.png") return null;
			// Capture the source variant once: a concurrent freeze must not change
			// cursor policy halfway through a single screenshot read.
			const resource = getTerminalResource(url.hostname);
			const projection = resource.kind === "live" ? await resource.screen.project() : resource.projection;
			const image = await writeTerminalImage(projection, resource.kind === "live");
			noteTerminalRead(url.hostname);
			return image;
		},
	};
	const host = router as TerminalUrlRouter;
	const existing = host.getHandler("term");
	if (existing !== undefined) {
		if (typeof existing !== "object" || existing === null || !(handlerBrand in existing) || existing[handlerBrand] !== true) {
			throw new Error("omp-unified-exec: term:// belongs to another handler; restart omp after upgrading the plugin");
		}
		// Every key is supplied, including locate. No stale module closure survives
		// reload; the router reads spec and methods from this object per request.
		Object.assign(existing, handler);
	} else {
		host.register(handler);
		if (host.getHandler("term") !== handler) {
			throw new Error("omp-unified-exec: InternalUrlRouter did not retain term handler identity");
		}
	}
}
