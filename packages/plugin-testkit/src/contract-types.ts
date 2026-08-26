import type { InstanceHandle, RuntimeConfig, ServiceRecord } from "localhost2137";

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

export interface OperationContractFixture<Services extends ServiceRecord> {
	readonly cli: "flags" | "json";
	readonly key: string;
	invoke(instance: InstanceHandle<Services>): ContractObservation | Promise<ContractObservation>;
}

export interface InvalidConfigurationFixture {
	create(): unknown;
	readonly expectedPath: string;
}

export interface PluginContractFixture<Services extends ServiceRecord> {
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
	readonly world: Readonly<{
		createConfig(): RuntimeConfig<Services>;
		readonly operations: readonly OperationContractFixture<Services>[];
		readonly serviceKey: Extract<keyof Services, string>;
	}>;
}
