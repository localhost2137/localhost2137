import { Hono } from "hono";
import type { RunningPluginContext } from "../authoring/context.js";
import type { RuntimePluginApi } from "./plugin-api-registry.js";

type WrapperEnvironment = {
	Bindings: { readonly localhostContext: RunningPluginContext<unknown, unknown> };
	Variables: { lh: RunningPluginContext<unknown, unknown> };
};

export class PluginApiWrappers {
	readonly #wrappers = new WeakMap<object, Map<string, Hono<WrapperEnvironment>>>();

	get(
		generation: object,
		serviceKey: string,
		pluginApi: RuntimePluginApi,
	): Hono<WrapperEnvironment> {
		const generationWrappers = this.#wrappers.get(generation) ?? new Map();
		this.#wrappers.set(generation, generationWrappers);
		const existing = generationWrappers.get(serviceKey);
		if (existing) return existing;

		const wrapper = new Hono<WrapperEnvironment>();
		wrapper.use("*", async (context, next) => {
			context.set("lh", context.env.localhostContext);
			await next();
		});
		wrapper.route("/", pluginApi);
		generationWrappers.set(serviceKey, wrapper);
		return wrapper;
	}
}
