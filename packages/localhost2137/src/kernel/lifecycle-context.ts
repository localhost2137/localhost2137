import type {
	BasePluginContext,
	PluginClock,
	PluginLogger,
	PluginStorage,
	RunningPluginContext,
	TaskTracker,
} from "../authoring/context.js";

type LifecycleConfigPrimitive = boolean | number | string | null;
interface LifecycleConfigObject {
	readonly [key: string]: LifecycleConfigData;
}
interface LifecycleConfigArray extends ReadonlyArray<LifecycleConfigData> {}
export type LifecycleConfigData =
	| LifecycleConfigPrimitive
	| LifecycleConfigObject
	| LifecycleConfigArray;

export interface LifecycleContextCapabilities<Config> {
	readonly clock: PluginClock;
	readonly config: Readonly<Config>;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly instanceId: string;
	readonly log: PluginLogger;
	readonly serviceKey: string;
	readonly signal: AbortSignal;
	readonly storage: PluginStorage;
	readonly tasks: TaskTracker;
}

export function createBasePluginContext<Config>(
	capabilities: LifecycleContextCapabilities<Config>,
): BasePluginContext<Config> {
	return Object.freeze({
		clock: capabilities.clock,
		config: capabilities.config,
		instanceId: capabilities.instanceId,
		log: capabilities.log,
		serviceKey: capabilities.serviceKey,
		signal: capabilities.signal,
		storage: capabilities.storage,
	});
}

export function createRunningPluginContext<State, Config>(
	capabilities: LifecycleContextCapabilities<Config>,
	state: State,
): RunningPluginContext<State, Config> {
	return Object.freeze({
		...createBasePluginContext(capabilities),
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			capabilities.fetch(input, withContextSignal(input, init, capabilities.signal)),
		state,
		tasks: capabilities.tasks,
	});
}

function withContextSignal(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	contextSignal: AbortSignal,
): RequestInit {
	const signals = [
		contextSignal,
		...(init?.signal ? [init.signal] : []),
		...(input instanceof Request ? [input.signal] : []),
	];
	return { ...init, signal: signals.length === 1 ? contextSignal : AbortSignal.any(signals) };
}
