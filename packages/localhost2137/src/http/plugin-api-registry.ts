import type { Hono } from "hono";
import type { RunningPluginContext } from "../authoring/context.js";
import type { ResolvedConfig } from "../config/config-resolution.js";

export type RuntimePluginApi = Hono<{
	Variables: { lh: RunningPluginContext<unknown, unknown> };
}>;

export interface PluginApiRegistry {
	resolve(serviceKey: string): RuntimePluginApi | undefined;
}

export class ResolvedPluginApiRegistry implements PluginApiRegistry {
	readonly #config: ResolvedConfig;

	constructor(config: ResolvedConfig) {
		this.#config = config;
	}

	resolve(serviceKey: string): RuntimePluginApi | undefined {
		const api = this.#config.services[serviceKey]?.plugin.api;
		if (!api) return undefined;
		// Config resolution verified the Hono-compatible fetch boundary. This cast
		// restores the erased plugin state/config parameters for the runtime wrapper.
		return api as RuntimePluginApi;
	}
}
