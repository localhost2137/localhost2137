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

interface BasePluginContext<ConfigSchema extends Schema> {
	readonly clock: PluginClock;
	readonly config: Readonly<z.output<ConfigSchema>>;
	readonly instanceId: string;
	readonly log: PluginLogger;
	readonly serviceKey: string;
	readonly signal: AbortSignal;
	readonly storage: PluginStorage;
}

interface RunningPluginContext<State, ConfigSchema extends Schema>
	extends BasePluginContext<ConfigSchema> {
	readonly state: State;
	readonly tasks: TaskTracker;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type PluginEnv<State, ConfigSchema extends Schema> = {
	Variables: { lh: RunningPluginContext<State, ConfigSchema> };
};

export interface OperationDefinition<
	InputSchema extends ObjectSchema,
	OutputSchema extends Schema,
> {
	readonly description: string;
	readonly input: InputSchema;
	readonly output: OutputSchema;
	run(
		context: RunningPluginContext<unknown, Schema>,
		input: z.output<InputSchema>,
	): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
}

export declare function defineOperation<
	const InputSchema extends ObjectSchema,
	const OutputSchema extends Schema,
>(
	definition: OperationDefinition<InputSchema, OutputSchema>,
): OperationDefinition<InputSchema, OutputSchema>;

interface OperationShape {
	readonly input: ObjectSchema;
	readonly output: Schema;
}

type OperationRecord = Readonly<Record<string, OperationShape>>;

export interface ConnectionMetadata {
	readonly env: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, unknown>>;
}

interface ConnectionContext<ConfigSchema extends Schema> {
	readonly baseUrl: string;
	readonly config: Readonly<z.output<ConfigSchema>>;
	readonly instanceId: string;
	readonly serviceKey: string;
}

interface PluginDefinition<
	ConfigSchema extends Schema,
	SeedSchema extends Schema | undefined,
	Operations extends OperationRecord,
	State,
	Connection extends ConnectionMetadata,
> {
	readonly api: Hono<PluginEnv<State, ConfigSchema>>;
	readonly configSchema: ConfigSchema;
	readonly connection: (context: ConnectionContext<ConfigSchema>) => Connection;
	readonly description: string;
	readonly id: string;
	readonly lifecycle: {
		readonly create: (context: BasePluginContext<ConfigSchema>) => Promise<void> | void;
		readonly seed?: (
			context: RunningPluginContext<State, ConfigSchema>,
			seed: SeedSchema extends Schema ? z.output<SeedSchema> : never,
		) => Promise<void> | void;
		readonly start: (context: BasePluginContext<ConfigSchema>) => State | Promise<State>;
		readonly stop?: (context: RunningPluginContext<State, ConfigSchema>) => Promise<void> | void;
		readonly update?: (
			context: BasePluginContext<ConfigSchema>,
			version: Readonly<{ from: number; to: number }>,
		) => Promise<void> | void;
	};
	readonly operations: Operations;
	readonly seedSchema?: SeedSchema;
	readonly stateVersion: number;
}

declare const configuredServiceType: unique symbol;

interface ConfiguredService<
	ConfigSchema extends Schema,
	SeedSchema extends Schema | undefined,
	Operations extends OperationRecord,
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
	Operations extends OperationRecord,
	Connection extends ConnectionMetadata,
> = (
	envelope: ServiceEnvelope<ConfigSchema, SeedSchema>,
) => ConfiguredService<ConfigSchema, SeedSchema, Operations, Connection>;

export declare function definePlugin<
	const ConfigSchema extends Schema,
	const SeedSchema extends Schema | undefined,
	const Operations extends OperationRecord,
	const State,
	const Connection extends ConnectionMetadata,
>(
	definition: PluginDefinition<ConfigSchema, SeedSchema, Operations, State, Connection>,
): PluginFactory<ConfigSchema, SeedSchema, Operations, Connection>;

type ServiceRecord = Readonly<
	Record<string, ConfiguredService<Schema, Schema | undefined, OperationRecord, ConnectionMetadata>>
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
		? Type extends { readonly connection: ConnectionMetadata; readonly operations: OperationRecord }
			? {
					readonly connection: Type["connection"]["values"];
				} & {
					readonly [Key in keyof Type["operations"]]: OperationMethod<Type["operations"][Key]>;
				}
			: never
		: never;

export type InstanceFacade<Services extends ServiceRecord> = {
	readonly [ServiceKey in keyof Services]: ServiceFacade<Services[ServiceKey]>;
} & {
	readonly env: Readonly<Record<string, string>>;
	idle(): Promise<void>;
};

export interface RuntimeConfig<Services extends ServiceRecord> {
	readonly clock?: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly host?: string;
	readonly port?: number;
	readonly seed?: (instance: InstanceFacade<Services>) => Promise<void> | void;
	readonly services: Services;
	readonly storage?: Readonly<{ dir: string }>;
}

export declare function defineConfig<const Services extends ServiceRecord>(
	config: Readonly<{ services: Services }> & RuntimeConfig<Services>,
): RuntimeConfig<Services>;
