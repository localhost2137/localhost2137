import type {
	InstanceHandle,
	ReservedServiceKey,
	RuntimeConfig,
	ServiceRecord,
} from "localhost2137";

/** A probe returns facts; the testkit, not the plugin fixture, owns the assertion. */
export interface ContractObservation {
	readonly actual: unknown;
	readonly expected: unknown;
}

export type ContractObservationProbe = () => ContractObservation | Promise<ContractObservation>;

export interface PluginContractCase {
	readonly name: string;
	run(): Promise<void>;
}

export type ContractServiceKey<Services extends ServiceRecord> = Extract<
	Exclude<keyof Services, ReservedServiceKey>,
	string
>;

export type ContractOperationKey<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> = Exclude<Extract<keyof InstanceHandle<Services>[ServiceKey], string>, "connection">;

export interface OperationContractFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services> = ContractServiceKey<Services>,
> {
	readonly cli: "flags" | "json";
	readonly key: ContractOperationKey<Services, ServiceKey>;
	invoke(instance: InstanceHandle<Services>): ContractObservation | Promise<ContractObservation>;
}

export interface InvalidConfigurationFixture {
	create(): unknown;
	readonly expectedPath: string;
}

interface PluginContractFixtureBase<Services extends ServiceRecord> {
	readonly authoring: Readonly<{
		sideEffects: ContractObservationProbe;
	}>;
	readonly durability: Readonly<{
		futureVersion: ContractObservationProbe;
		restartPersistence: ContractObservationProbe;
		stateUpgrade: ContractObservationProbe;
	}>;
	readonly invalid: Readonly<{
		config: InvalidConfigurationFixture;
		environmentCollision: InvalidConfigurationFixture;
		seed: InvalidConfigurationFixture;
	}>;
	readonly lifecycle: Readonly<{
		createFailureRecovery: ContractObservationProbe;
		ordering: ContractObservationProbe;
		updateFailureRecovery: ContractObservationProbe;
	}>;
	readonly probes: Readonly<{
		connection: Readonly<{
			readonly environmentName: string;
			readUrl(instance: InstanceHandle<Services>): string;
		}>;
		honoContext(instance: InstanceHandle<Services>): Promise<ContractObservation>;
		readonly isolation: Readonly<{
			readonly expectedFresh: unknown;
			readonly expectedMutated: unknown;
			mutate(instance: InstanceHandle<Services>): Promise<void>;
			read(instance: InstanceHandle<Services>): Promise<unknown>;
		}>;
		outputValidation: ContractObservationProbe;
		readonly reset: Readonly<{
			readonly expectedEmpty: unknown;
			readonly expectedSeeded: unknown;
			mutate(instance: InstanceHandle<Services>): Promise<void>;
			read(instance: InstanceHandle<Services>): Promise<unknown>;
		}>;
		storageEscape: ContractObservationProbe;
		trackedFetchAndIdle(instance: InstanceHandle<Services>): Promise<ContractObservation>;
	}>;
}

type PluginContractWorld<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> = Readonly<{
	createConfig(): RuntimeConfig<Services>;
	readonly operations: readonly OperationContractFixture<Services, ServiceKey>[];
	readonly serviceKey: ServiceKey;
}>;

/**
 * Trusted executable fixture code for one selected configured service.
 *
 * The testkit owns orchestration and assertions, but it cannot infer plugin-specific semantics.
 * Probe and factory callbacks must exercise the selected plugin rather than synthesize a pass.
 */
export type PluginContractFixture<Services extends ServiceRecord> = {
	[ServiceKey in ContractServiceKey<Services>]: PluginContractFixtureBase<Services> &
		Readonly<{ world: PluginContractWorld<Services, ServiceKey> }>;
}[ContractServiceKey<Services>];
