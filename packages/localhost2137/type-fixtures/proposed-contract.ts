/**
 * Declaration-only candidate for the Phase 1 authoring contract.
 *
 * Nothing in this file is emitted or exported by the package. The declarations
 * let Phase 0 freeze inference requirements without shipping placeholder
 * runtime functions. Phase 1 must make the same fixtures pass against real
 * imports from `localhost2137`, then remove this candidate module.
 */
import type { Hono } from "hono";
import type { z } from "zod";

type ObjectSchema = z.ZodObject;
type Schema = z.ZodType;

interface PluginClock {
	now(): Date;
}

interface PluginStorage {
	path(relativePath: string): string;
}

interface TaskTracker {
	track<T>(label: string, task: Promise<T>): Promise<T>;
}

interface PluginLogger {
	info(message: string, attributes?: Readonly<Record<string, unknown>>): void;
}

interface BasePluginContext<Config> {
	readonly clock: PluginClock;
	readonly config: Readonly<Config>;
	readonly instanceId: string;
	readonly log: PluginLogger;
	readonly serviceKey: string;
	readonly signal: AbortSignal;
	readonly storage: PluginStorage;
}

interface RunningPluginContext<State, Config> extends BasePluginContext<Config> {
	readonly state: State;
	readonly tasks: TaskTracker;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type PluginEnv<State, Config> = {
	Variables: { lh: RunningPluginContext<State, Config> };
};

declare const operationContextType: unique symbol;

interface OperationShape {
	readonly input: ObjectSchema;
	readonly output: Schema;
}

interface BoundOperationShape<State, Config> extends OperationShape {
	readonly [operationContextType]: (
		state: State,
		config: Config,
	) => readonly [state: State, config: Config];
}

interface OperationDefinitionInput<
	State,
	Config,
	InputSchema extends ObjectSchema,
	OutputSchema extends Schema,
> {
	readonly description: string;
	readonly input: InputSchema;
	readonly output: OutputSchema;
	run(
		context: RunningPluginContext<State, Config>,
		input: z.output<InputSchema>,
	): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
}

type OperationDefinition<
	State,
	Config,
	InputSchema extends ObjectSchema,
	OutputSchema extends Schema,
> = OperationDefinitionInput<State, Config, InputSchema, OutputSchema> &
	BoundOperationShape<State, Config>;

type BoundOperationDefinition<State, Config> = <
	const InputSchema extends ObjectSchema,
	const OutputSchema extends Schema,
>(
	definition: OperationDefinitionInput<State, Config, InputSchema, OutputSchema>,
) => OperationDefinition<State, Config, InputSchema, OutputSchema>;

/** Create one context-bound operation helper per plugin module. */
export declare function defineOperation<State, Config>(): BoundOperationDefinition<State, Config>;

type OperationRecord<State, Config> = Readonly<Record<string, BoundOperationShape<State, Config>>>;

interface ConnectionMetadata {
	readonly env: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, unknown>>;
}

interface ConnectionContext<Config> {
	readonly baseUrl: string;
	readonly config: Readonly<Config>;
	readonly instanceId: string;
	readonly serviceKey: string;
}

interface Lifecycle<State, Config> {
	readonly create: (context: BasePluginContext<Config>) => Promise<void> | void;
	readonly start: (context: BasePluginContext<Config>) => State | Promise<State>;
	readonly stop?: (context: RunningPluginContext<State, Config>) => Promise<void> | void;
	readonly update?: (
		context: BasePluginContext<Config>,
		version: Readonly<{ from: number; to: number }>,
	) => Promise<void> | void;
}

interface PluginDefinitionBase<
	ConfigSchema extends Schema,
	State,
	Operations extends OperationRecord<State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> {
	readonly api: Hono<PluginEnv<State, z.output<ConfigSchema>>>;
	readonly configSchema: ConfigSchema;
	readonly connection: (context: ConnectionContext<z.output<ConfigSchema>>) => Connection;
	readonly description: string;
	readonly id: string;
	readonly operations: Operations;
	readonly stateVersion: number;
}

type SeededPluginDefinition<
	ConfigSchema extends Schema,
	SeedSchema extends Schema,
	State,
	Operations extends OperationRecord<State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> = PluginDefinitionBase<ConfigSchema, State, Operations, Connection> & {
	readonly lifecycle: Lifecycle<State, z.output<ConfigSchema>> & {
		readonly seed: (
			context: RunningPluginContext<State, z.output<ConfigSchema>>,
			seed: z.output<SeedSchema>,
		) => Promise<void> | void;
	};
	readonly seedSchema: SeedSchema;
};

type UnseededPluginDefinition<
	ConfigSchema extends Schema,
	State,
	Operations extends OperationRecord<State, z.output<ConfigSchema>>,
	Connection extends ConnectionMetadata,
> = PluginDefinitionBase<ConfigSchema, State, Operations, Connection> & {
	readonly lifecycle: Lifecycle<State, z.output<ConfigSchema>> & { readonly seed?: never };
	readonly seedSchema?: never;
};

declare const configuredServiceType: unique symbol;

interface ConfiguredService<
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

type PluginFactory<
	ConfigSchema extends Schema,
	SeedSchema extends Schema | undefined,
	Operations,
	Connection extends ConnectionMetadata,
> = (
	envelope: ServiceEnvelope<ConfigSchema, SeedSchema>,
) => ConfiguredService<ConfigSchema, SeedSchema, Operations, Connection>;

export declare function definePlugin<
	const ConfigSchema extends Schema,
	const SeedSchema extends Schema,
	const State,
	const Operations extends OperationRecord<State, z.output<ConfigSchema>>,
	const Connection extends ConnectionMetadata,
>(
	definition: SeededPluginDefinition<ConfigSchema, SeedSchema, State, Operations, Connection>,
): PluginFactory<ConfigSchema, SeedSchema, Operations, Connection>;

export declare function definePlugin<
	const ConfigSchema extends Schema,
	const State,
	const Operations extends OperationRecord<State, z.output<ConfigSchema>>,
	const Connection extends ConnectionMetadata,
>(
	definition: UnseededPluginDefinition<ConfigSchema, State, Operations, Connection>,
): PluginFactory<ConfigSchema, undefined, Operations, Connection>;

type ServiceRecord = Readonly<
	Record<string, ConfiguredService<Schema, Schema | undefined, unknown, ConnectionMetadata>>
>;

type ServiceType<Service> =
	Service extends ConfiguredService<
		infer ConfigSchema,
		infer SeedSchema,
		infer Operations,
		infer Connection
	>
		? {
				readonly config: ConfigSchema;
				readonly connection: Connection;
				readonly operations: Operations;
				readonly seed: SeedSchema;
			}
		: never;

type OperationMethod<Operation extends OperationShape> = (
	input: z.input<Operation["input"]>,
) => Promise<z.output<Operation["output"]>>;

type ServiceFacade<Service> =
	ServiceType<Service> extends infer Type
		? Type extends {
				readonly connection: ConnectionMetadata;
				readonly operations: Readonly<Record<string, OperationShape>>;
			}
			? {
					readonly connection: Type["connection"]["values"];
				} & {
					readonly [Key in keyof Type["operations"]]: OperationMethod<Type["operations"][Key]>;
				}
			: never
		: never;

/** Facade used while an exclusive seed lease is already held. */
export type ScenarioFacade<Services extends ServiceRecord> = {
	readonly [ServiceKey in keyof Services]: ServiceFacade<Services[ServiceKey]>;
};

/** External testing/client handle; unlike ScenarioFacade, it may manage the instance. */
export type InstanceHandle<Services extends ServiceRecord> = ScenarioFacade<Services> & {
	readonly env: Readonly<Record<string, string>>;
	idle(): Promise<void>;
};

export interface RuntimeConfig<Services extends ServiceRecord> {
	readonly clock?: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly host?: string;
	readonly port?: number;
	readonly seed?: (scenario: ScenarioFacade<Services>) => Promise<void> | void;
	readonly services: Services;
	readonly storage?: Readonly<{ dir: string }>;
}

export declare function defineConfig<const Services extends ServiceRecord>(
	config: Readonly<{ services: Services }> & RuntimeConfig<Services>,
): RuntimeConfig<Services>;
