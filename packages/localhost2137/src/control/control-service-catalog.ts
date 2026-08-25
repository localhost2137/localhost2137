import type { ResolvedConfig } from "../config/config-resolution.js";
import type { OperationMetadata } from "../config/schema-metadata.js";

export interface ControlServiceSummary {
	readonly description: string;
	readonly name: string;
	readonly operations: readonly string[];
	readonly pluginId: string;
	readonly stateVersion: number;
}

export interface ControlServiceDescription extends ControlServiceSummary {
	readonly operationMetadata: Readonly<Record<string, OperationMetadata>>;
}

export interface ControlServiceCatalog {
	describe(serviceKey: string): ControlServiceDescription | undefined;
	list(): readonly ControlServiceSummary[];
}

export class ResolvedControlServiceCatalog implements ControlServiceCatalog {
	readonly #services: readonly ControlServiceDescription[];
	readonly #summaries: readonly ControlServiceSummary[];

	constructor(config: ResolvedConfig) {
		this.#services = Object.freeze(
			Object.entries(config.services).map(([name, service]) =>
				Object.freeze({
					description: String(service.plugin.description),
					name,
					operationMetadata: service.operations,
					operations: Object.freeze(Object.keys(service.operations)),
					pluginId: service.pluginId,
					stateVersion: service.stateVersion,
				}),
			),
		);
		this.#summaries = Object.freeze(
			this.#services.map(({ operationMetadata: _operationMetadata, ...summary }) =>
				Object.freeze(summary),
			),
		);
	}

	describe(serviceKey: string): ControlServiceDescription | undefined {
		return this.#services.find(({ name }) => name === serviceKey);
	}

	list(): readonly ControlServiceSummary[] {
		return this.#summaries;
	}
}
