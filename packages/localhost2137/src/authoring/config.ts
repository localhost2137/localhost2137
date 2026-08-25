import type { z } from "zod";
import type { ConfiguredService, ConnectionMetadata } from "./plugin.js";
import type { OperationShape, Schema } from "./operation.js";

export type ServiceRecord = Readonly<
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
					readonly [Key in Exclude<
						keyof Type["operations"],
						ReservedOperationKey
					>]: OperationMethod<Type["operations"][Key]>;
				}
			: never
		: never;

type ReservedOperationKey = "connection";

export type ReservedServiceKey = "_" | "clock" | "destroy" | "env" | "idle" | "reset" | "seed";

/** Facade used while an exclusive seed lease is already held. */
export type ScenarioFacade<Services extends ServiceRecord> = {
	readonly [ServiceKey in Exclude<keyof Services, ReservedServiceKey>]: ServiceFacade<
		Services[ServiceKey]
	>;
};

export interface InstanceClockStatus {
	readonly mode: "pinned" | "real";
	/** Current instance time as an RFC 3339 timestamp. */
	readonly now: string;
}

interface InstanceClockHandle {
	status(): Promise<InstanceClockStatus>;
}

/** External testing/client handle; unlike ScenarioFacade, it may manage the instance. */
export type InstanceHandle<Services extends ServiceRecord> = ScenarioFacade<Services> & {
	readonly clock: InstanceClockHandle;
	readonly env: Readonly<Record<string, string>>;
	destroy(): Promise<void>;
	idle(): Promise<void>;
	reset(options?: Readonly<{ seed?: boolean }>): Promise<void>;
	seed(): Promise<void>;
};

type ServicesWithoutReservedKeys<Services extends ServiceRecord> = Services & {
	readonly [ServiceKey in Extract<keyof Services, ReservedServiceKey>]: never;
};

export interface RuntimeConfig<Services extends ServiceRecord> {
	readonly clock?: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly host?: string;
	readonly port?: number;
	readonly seed?: (scenario: ScenarioFacade<Services>) => Promise<void> | void;
	readonly services: ServicesWithoutReservedKeys<Services>;
	readonly storage?: Readonly<{ dir: string }>;
}

export function defineConfig<const Services extends ServiceRecord>(
	config: RuntimeConfig<Services>,
): RuntimeConfig<Services> {
	return config;
}
