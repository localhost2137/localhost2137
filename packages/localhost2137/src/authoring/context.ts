export interface PluginClock {
	now(): Date;
}

export interface PluginStorage {
	path(relativePath: string): string;
}

export interface TaskTracker {
	track<T>(label: string, task: Promise<T>): Promise<T>;
}

export interface PluginLogger {
	info(message: string, attributes?: Readonly<Record<string, unknown>>): void;
}

export interface BasePluginContext<Config> {
	readonly clock: PluginClock;
	readonly config: Readonly<Config>;
	readonly instanceId: string;
	readonly log: PluginLogger;
	readonly serviceKey: string;
	readonly signal: AbortSignal;
	readonly storage: PluginStorage;
}

export interface RunningPluginContext<State, Config> extends BasePluginContext<Config> {
	readonly state: State;
	readonly tasks: TaskTracker;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Hono environment for the per-request context injected by localhost2137. */
export type PluginEnv<State, Config> = {
	Variables: { lh: RunningPluginContext<State, Config> };
};
