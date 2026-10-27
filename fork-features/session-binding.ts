/**
 * Binding to omp's internal AgentSession (#29), used by command approval and
 * by the stop detectors (its settings, model registry and judgment ledger).
 * The first session_start resolves the registry once; switches and branches
 * only recheck the retained sessionManager identity. Registry entries can be
 * replaced by same-id helper sessions, so they must not be looked up again.
 */
export interface HostSettings {
	getShellConfig(): { readonly shell: string };
}

export interface BoundSession {
	readonly settings: HostSettings;
	readonly sessionManager: unknown;
}

export interface SessionRegistry {
	readonly registeredSession: (agentId: string) => { readonly session: unknown } | undefined;
}

export type HostBindingState =
	| { readonly kind: "pending" }
	| { readonly kind: "unbound"; readonly reason: "no-registry-entry" | "identity-mismatch" }
	| { readonly kind: "bound"; readonly session: BoundSession; readonly agentId: string };

export interface BindingContext {
	readonly agentId: string | undefined;
	readonly sessionManager: unknown;
}

export function bindingContext(ctx: unknown): BindingContext {
	const agent = typeof ctx === "object" && ctx !== null && "agent" in ctx ? ctx.agent : undefined;
	const id = typeof agent === "object" && agent !== null && "id" in agent ? agent.id : undefined;
	const sessionManager = typeof ctx === "object" && ctx !== null && "sessionManager" in ctx ? ctx.sessionManager : undefined;
	return { agentId: typeof id === "string" ? id : undefined, sessionManager };
}

export function bindSession(host: SessionRegistry, ctx: BindingContext): HostBindingState {
	const registered = ctx.agentId === undefined ? undefined : host.registeredSession(ctx.agentId);
	const session = registered?.session;
	if (ctx.agentId === undefined || typeof session !== "object" || session === null ||
		!("settings" in session) || !("sessionManager" in session)) {
		return { kind: "unbound", reason: "no-registry-entry" };
	}
	if (session.sessionManager !== ctx.sessionManager) return { kind: "unbound", reason: "identity-mismatch" };
	// Keep the actual AgentSession: its owner can replace settings at runtime.
	return { kind: "bound", session: session as BoundSession, agentId: ctx.agentId };
}

export function recheckBinding(binding: HostBindingState, ctx: BindingContext): HostBindingState {
	switch (binding.kind) {
		case "pending":
		case "unbound":
			return binding;
		case "bound":
			return binding.session.sessionManager === ctx.sessionManager
				? binding : { kind: "unbound", reason: "identity-mismatch" };
	}
}
