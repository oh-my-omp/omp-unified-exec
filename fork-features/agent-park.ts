/**
 * Agent park: omp parks a finished subagent after `task.agentIdleTtlMs` of
 * idleness (default seven minutes). Parking disposes its AgentSession, which
 * ends this extension's activation with a `session_shutdown` that carries no
 * cause; a later `ensureLive` revives the agent as a new AgentSession with a
 * new activation. The agent's terminals belong to the agent, not to one
 * activation, so they outlive the park and the revived activation resumes
 * them.
 *
 * omp owns the agent's lifecycle; this module only reads it:
 *   - the registry entry (`AgentRef`) is the agent's generation: it survives
 *     park and revive, and a reused id gets a new one;
 *   - `isParking` is true from the park's start through the disposal, so it
 *     tells a park's `session_shutdown` from a real end;
 *   - `has` says the task executor adopted the agent: its task is finished
 *     and its result went back to its parent;
 *   - `ensureLive` revives a parked agent and returns once the new
 *     activation saw `session_start`;
 *   - a registry `removed`, or a status change to `aborted`, ends a
 *     generation for good.
 */

declare const generationBrand: unique symbol;

/** omp's registry entry for one generation of an agent; compared by identity only. */
export interface AgentGeneration {
	readonly [generationBrand]: true;
}

/** The agent an activation runs for, as omp's registry knows it. */
export interface AgentIdentity {
	readonly agentId: string;
	readonly generation: AgentGeneration;
}

export interface AgentHost {
	/** The current generation registered under `agentId`, if any. */
	identify(agentId: string): AgentIdentity | undefined;
	/** omp is parking this generation (true through its session's disposal). */
	isParking(agent: AgentIdentity): boolean;
	/** The task executor adopted this generation: its task is finished. */
	isAdopted(agent: AgentIdentity): boolean;
	/** Revive the agent; resolves after its new activation saw `session_start`. */
	revive(agentId: string): Promise<void>;
	/** Call `listener` with every generation that ended for good (removed or aborted). */
	onEnded(listener: (generation: AgentGeneration) => void): () => void;
}

function property(value: unknown, name: string): unknown {
	// Classes (AgentRegistry, AgentLifecycleManager) are functions.
	return (typeof value === "object" || typeof value === "function") && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

function method(owner: unknown, name: string, from: string): (...args: unknown[]) => unknown {
	const value = property(owner, name);
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}()`);
	return (...args) => Reflect.apply(value, owner, args);
}

function singleton(module: unknown, name: string): unknown {
	const owner = property(module, name);
	return method(owner, "global", name)();
}

/** Factory-only imports: a reshaped omp rejects loading. */
export async function loadAgentHost(): Promise<AgentHost> {
	const [root, lifecycleModule] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle"),
	]);
	return parseAgentHost(root, lifecycleModule);
}

/** omp's root module and `registry/agent-lifecycle` as an AgentHost; throws when their exports changed shape. */
export function parseAgentHost(root: unknown, lifecycleModule: unknown): AgentHost {
	const registry = singleton(root, "AgentRegistry");
	const get = method(registry, "get", "AgentRegistry");
	const onChange = method(registry, "onChange", "AgentRegistry");
	// The manager rebinds itself when the global registry changes, so it is read per call; check its shape once here.
	const lifecycle = () => singleton(lifecycleModule, "AgentLifecycleManager");
	for (const name of ["isParking", "has", "ensureLive"]) method(lifecycle(), name, "AgentLifecycleManager");
	return {
		identify: (agentId) => {
			const ref = get(agentId);
			// Parse the registry entry at the boundary; afterwards it is only an identity.
			return typeof ref === "object" && ref !== null ? { agentId, generation: ref as AgentGeneration } : undefined;
		},
		isParking: (agent) => method(lifecycle(), "isParking", "AgentLifecycleManager")(agent.agentId, agent.generation) === true,
		isAdopted: (agent) => method(lifecycle(), "has", "AgentLifecycleManager")(agent.agentId, agent.generation) === true,
		revive: async (agentId) => {
			await method(lifecycle(), "ensureLive", "AgentLifecycleManager")(agentId);
		},
		onEnded: (listener) => {
			const unsubscribe = onChange((event: unknown) => {
				const type = property(event, "type");
				const ref = property(event, "ref");
				if (typeof ref !== "object" || ref === null) return;
				if (type === "removed" || (type === "status_changed" && property(ref, "status") === "aborted")) listener(ref as AgentGeneration);
			});
			if (typeof unsubscribe !== "function") throw new Error("omp-unified-exec: AgentRegistry.onChange() returned no unsubscribe");
			return () => void unsubscribe();
		},
	};
}

/** What a parked agent leaves behind: its terminals, ended only by `end`. */
export interface ParkedRuntime {
	end(): Promise<void>;
}

/**
 * The parked agents' terminal runtimes, keyed by generation. One per process:
 * every activation of this extension (parent, children, revived children,
 * reloads) shares it, and one registry listener ends what a released or
 * aborted generation left behind.
 */
export class ParkedRuntimes<T extends ParkedRuntime> {
	private readonly held = new Map<AgentGeneration, T>();
	private readonly endings = new Set<Promise<void>>();
	private unsubscribe: (() => void) | undefined;

	/** Keep `runtime` until its generation resumes it or ends. */
	hold(host: AgentHost, generation: AgentGeneration, runtime: T): void {
		this.held.set(generation, runtime);
		this.unsubscribe ??= host.onEnded((ended) => {
			const parked = this.held.get(ended);
			if (!parked) return;
			this.held.delete(ended);
			const ending = parked.end();
			this.endings.add(ending);
			void ending.finally(() => this.endings.delete(ending));
		});
	}

	/** The runtime a revived generation resumes; it is no longer held. */
	take(generation: AgentGeneration): T | undefined {
		const runtime = this.held.get(generation);
		this.held.delete(generation);
		return runtime;
	}

	/** Endings already started (a main session's teardown releases its parked children first). */
	async settled(): Promise<void> {
		await Promise.all(this.endings);
	}

	/** Held runtimes (test helper). */
	get size(): number {
		return this.held.size;
	}
}

const registrySymbol = Symbol.for("omp-unified-exec.parked-runtimes");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: ParkedRuntimes<ParkedRuntime> };

/**
 * The process's parked runtimes. Every activation stores the same runtime
 * type, so the element type is the caller's.
 */
export function parkedRuntimes<T extends ParkedRuntime>(): ParkedRuntimes<T> {
	return (processGlobal[registrySymbol] ??= new ParkedRuntimes()) as ParkedRuntimes<T>;
}
