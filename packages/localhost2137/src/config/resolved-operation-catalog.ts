import type { RuntimeOperationDefinition } from "../authoring/plugin.js";
import type { OperationDescriptorResolver } from "../kernel/operation-executor.js";
import type { ResolvedConfig } from "./config-resolution.js";

export class ResolvedOperationCatalog implements OperationDescriptorResolver {
	readonly #config: ResolvedConfig;

	constructor(config: ResolvedConfig) {
		this.#config = config;
	}

	resolve(serviceKey: string, operationKey: string): RuntimeOperationDefinition | undefined {
		return this.#config.services[serviceKey]?.plugin.operations[operationKey];
	}
}
