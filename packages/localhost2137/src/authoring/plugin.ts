import type { Hono } from "hono";
import type { z } from "zod";
import type { BasePluginContext, PluginEnv, RunningPluginContext } from "./context.js";
import {
	readOperationBinding,
	type BoundOperationShape,
	type OperationShape,
	type Schema,
} from "./operation.js";

export type ReservedOperationKey = "connection";

export type OperationRecord<PluginId extends string, State, Config> = Readonly<
	Record<string, BoundOperationShape<PluginId, State, Config>>
> & {
	readonly [Key in ReservedOperationKey]?: never;
};

export interface ConnectionMetadata {
	readonly env: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, unknown>>;
}

export interface ConnectionContext<Config> {
	readonly baseUrl: string;
	readonly config: Readonly<Config>;
	readonly instanceId: string;
	readonly serviceKey: string;
}

export interface Lifecycle<State, Config> {
	readonly create: (context: BasePluginContext<Config>) => Promise<void> | void;
	readonly start: (context: BasePluginContext<Config>) => State | Promise<State>;
	readonly stop?: (context: RunningPluginContext<State, Config>) => Promise<void> | void;
	readonly update?: (
		context: BasePluginContext<Config>,
		version: Readonly<{ from: number; to: number }>,
	) => Promise<void> | void;
}

interface PluginDefinitionBase<
	PluginId extends string,
	ConfigSchema extends Schema,
	State,
	Operations extends OperationRecord<PluginId, State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> {
	readonly api: Hono<PluginEnv<State, z.output<ConfigSchema>>>;
	readonly configSchema: ConfigSchema;
	readonly connection: (context: ConnectionContext<z.output<ConfigSchema>>) => Connection;
	readonly description: string;
	readonly id: PluginId;
	readonly operations: Operations;
	readonly stateVersion: number;
}

export type SeededPluginDefinition<
	PluginId extends string,
	ConfigSchema extends Schema,
	SeedSchema extends Schema,
	State,
	Operations extends OperationRecord<PluginId, State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> = PluginDefinitionBase<PluginId, ConfigSchema, State, Operations, Connection> & {
	readonly lifecycle: Lifecycle<State, z.output<ConfigSchema>> & {
		readonly seed: (
			context: RunningPluginContext<State, z.output<ConfigSchema>>,
			seed: z.output<SeedSchema>,
		) => Promise<void> | void;
	};
	readonly seedSchema: SeedSchema;
};

export type UnseededPluginDefinition<
	PluginId extends string,
	ConfigSchema extends Schema,
	State,
	Operations extends OperationRecord<PluginId, State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> = PluginDefinitionBase<PluginId, ConfigSchema, State, Operations, Connection> & {
	readonly lifecycle: Lifecycle<State, z.output<ConfigSchema>> & { readonly seed?: never };
	readonly seedSchema?: never;
};

declare const configuredServiceType: unique symbol;
// Symbol.for keeps runtime descriptors recognizable when tsx imports a config
// in its isolated loader namespace or a compatible plugin resolves another copy.
const configuredServiceRuntimeType: unique symbol = Symbol.for(
	"localhost2137.configuredServiceRuntime.v1",
);

export interface ConfiguredService<
	ConfigSchema extends Schema,
	SeedSchema extends Schema | undefined,
	Operations,
	Connection extends ConnectionMetadata,
> {
	readonly [configuredServiceType]: {
		readonly config: ConfigSchema;
		readonly connection: Connection;
		readonly operations: Operations;
		readonly seed: SeedSchema;
	};
}

type ServiceEnvelope<ConfigSchema extends Schema, SeedSchema extends Schema | undefined> = {
	readonly config: z.input<ConfigSchema>;
	readonly exportEnv?: boolean;
} & (SeedSchema extends Schema
	? { readonly seed?: z.input<SeedSchema> }
	: { readonly seed?: never });

export type PluginFactory<
	ConfigSchema extends Schema,
	SeedSchema extends Schema | undefined,
	Operations,
	Connection extends ConnectionMetadata,
> = (
	envelope: ServiceEnvelope<ConfigSchema, SeedSchema>,
) => ConfiguredService<ConfigSchema, SeedSchema, Operations, Connection>;

export interface RuntimePluginDefinition {
	readonly api: unknown;
	readonly configSchema: Schema;
	readonly connection: unknown;
	readonly description: unknown;
	readonly id: string;
	readonly lifecycle: object;
	readonly operations: Readonly<Record<string, RuntimeOperationDefinition>>;
	readonly seedSchema?: Schema;
	readonly stateVersion: unknown;
}

export type RuntimeOperationDefinition = OperationShape & { readonly run: unknown };

export interface ConfiguredServiceRuntime {
	readonly definition: RuntimePluginDefinition;
	readonly envelope: Readonly<{ config: unknown; exportEnv?: unknown; seed?: unknown }>;
}

export function definePlugin<
	const PluginId extends string,
	const ConfigSchema extends Schema,
	const SeedSchema extends Schema,
	const State,
	const Operations extends OperationRecord<PluginId, State, z.output<ConfigSchema>>,
	const Connection extends ConnectionMetadata,
>(
	definition: SeededPluginDefinition<
		PluginId,
		ConfigSchema,
		SeedSchema,
		State,
		Operations,
		Connection
	>,
): PluginFactory<ConfigSchema, SeedSchema, Operations, Connection>;
export function definePlugin<
	const PluginId extends string,
	const ConfigSchema extends Schema,
	const State,
	const Operations extends OperationRecord<PluginId, State, z.output<ConfigSchema>>,
	const Connection extends ConnectionMetadata,
>(
	definition: UnseededPluginDefinition<PluginId, ConfigSchema, State, Operations, Connection>,
): PluginFactory<ConfigSchema, undefined, Operations, Connection>;
export function definePlugin(
	definition: RuntimePluginDefinition,
): PluginFactory<
	Schema,
	Schema | undefined,
	Readonly<Record<string, RuntimeOperationDefinition>>,
	ConnectionMetadata
> {
	assertOperationBindings(definition);

	const ownedDefinition = Object.freeze({
		...definition,
		lifecycle: Object.freeze({ ...definition.lifecycle }),
		operations: Object.freeze({ ...definition.operations }),
	});

	return Object.freeze(
		(envelope: Readonly<{ config: unknown; exportEnv?: unknown; seed?: unknown }>) => {
			const descriptor = {};
			Object.defineProperty(descriptor, configuredServiceRuntimeType, {
				configurable: false,
				enumerable: false,
				value: Object.freeze({
					definition: ownedDefinition,
					envelope: Object.freeze({ ...envelope }),
				}),
				writable: false,
			});
			return Object.freeze(descriptor) as ConfiguredService<
				Schema,
				Schema | undefined,
				Readonly<Record<string, RuntimeOperationDefinition>>,
				ConnectionMetadata
			>;
		},
	);
}

function assertOperationBindings(definition: RuntimePluginDefinition): void {
	let binderToken: object | undefined;

	for (const operation of Object.values(definition.operations)) {
		const binding = readOperationBinding(operation);
		if (!binding) {
			throw new TypeError(`Plugin "${definition.id}" contains an unbound operation.`);
		}
		if (binderToken && binding.token !== binderToken) {
			throw new TypeError(`Plugin "${definition.id}" mixes operations from different binders.`);
		}
		binderToken = binding.token;
	}
}

export function readConfiguredService(value: unknown): ConfiguredServiceRuntime | undefined {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return undefined;
	}
	if (!(configuredServiceRuntimeType in value)) {
		return undefined;
	}

	const descriptor = value[configuredServiceRuntimeType];
	return isConfiguredServiceRuntime(descriptor) ? descriptor : undefined;
}

function isConfiguredServiceRuntime(value: unknown): value is ConfiguredServiceRuntime {
	return (
		typeof value === "object" &&
		value !== null &&
		"definition" in value &&
		typeof value.definition === "object" &&
		value.definition !== null &&
		"envelope" in value &&
		typeof value.envelope === "object" &&
		value.envelope !== null
	);
}
