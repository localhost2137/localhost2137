import type {
	InstanceHandle,
	ReservedServiceKey,
	RuntimeConfig,
	ServiceRecord,
} from "localhost2137";

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

export type ContractOperationInput<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
	OperationKey extends ContractOperationKey<Services, ServiceKey>,
> = InstanceHandle<Services>[ServiceKey][OperationKey] extends (
	input: infer Input,
) => Promise<unknown>
	? Input
	: never;

export type ContractOperationOutput<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
	OperationKey extends ContractOperationKey<Services, ServiceKey>,
> = InstanceHandle<Services>[ServiceKey][OperationKey] extends (
	input: never,
) => Promise<infer Output>
	? Output
	: never;

export type ContractOperationCall<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> = {
	[OperationKey in ContractOperationKey<Services, ServiceKey>]: Readonly<{
		input: ContractOperationInput<Services, ServiceKey, OperationKey>;
		operation: OperationKey;
	}>;
}[ContractOperationKey<Services, ServiceKey>];

export type OperationContractFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> = {
	[OperationKey in ContractOperationKey<Services, ServiceKey>]: Readonly<{
		cli: "flags" | "json";
		expected: ContractOperationOutput<Services, ServiceKey, OperationKey>;
		input: ContractOperationInput<Services, ServiceKey, OperationKey>;
		key: OperationKey;
	}>;
}[ContractOperationKey<Services, ServiceKey>];

export type ContractHarnessVariant =
	| "base"
	| "create-fails-once"
	| "invalid-output"
	| "storage-escape";

export type ContractLifecycleEvent =
	| "create"
	| "seed"
	| "start"
	| "stop"
	| `update:${number}:${number}`;

export interface ContractInstrumentation {
	record(event: ContractLifecycleEvent): void;
}

export interface ContractHarnessConfigOptions {
	readonly instrumentation: ContractInstrumentation;
	readonly variant: ContractHarnessVariant;
}

export interface SelectedPluginHarness<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	/** Build the selected service through the same production plugin factory used by every variant. */
	createConfig(options: ContractHarnessConfigOptions): RuntimeConfig<Services>;
	/** Build an intentionally invalid selected-service envelope. This pre-readiness variant is trusted. */
	createInvalidConfig(kind: "config" | "seed"): unknown;
	/** Build one base service so the testkit can mount the same family twice for collision checks. */
	createService(): Services[ServiceKey];
	readonly pluginId: string;
	readonly stateVersion: number;
}

export interface ContractAuthoringFixture {
	/** A file URL for an authoring module that exports a base config without starting a runtime. */
	readonly module: URL;
	readonly exportName: string;
}

export interface ContractDurabilityFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	/** A file URL for a CLI config module using the documented contract-test environment variables. */
	readonly configModule: URL;
	readonly expectedInitial: unknown;
	readonly expectedPersisted: unknown;
	readonly read: ContractOperationCall<Services, ServiceKey>;
	readonly versions: Readonly<{
		current: number;
		future: number;
		old: number;
	}>;
	readonly write: ContractOperationCall<Services, ServiceKey>;
}

export interface ContractDynamicInputFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
	OperationKey extends ContractOperationKey<Services, ServiceKey> = ContractOperationKey<
		Services,
		ServiceKey
	>,
> {
	readonly expected: ContractOperationOutput<Services, ServiceKey, OperationKey>;
	input(testkitOwnedUrl: string): ContractOperationInput<Services, ServiceKey, OperationKey>;
	readonly operation: OperationKey;
}

interface PluginContractFixtureBase<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	readonly authoring: ContractAuthoringFixture;
	readonly connection: Readonly<{
		readonly environmentName: string;
		readonly valueKey: Extract<keyof InstanceHandle<Services>[ServiceKey]["connection"], string>;
	}>;
	readonly durability: ContractDurabilityFixture<Services, ServiceKey>;
	readonly faults: Readonly<{
		readonly invalidOutput: ContractOperationCall<Services, ServiceKey>;
		readonly storageEscape: ContractOperationCall<Services, ServiceKey>;
	}>;
	readonly harness: SelectedPluginHarness<Services, ServiceKey>;
	readonly hono: Readonly<{
		readonly expectedBody: unknown;
		readonly expectedStatus: number;
		readonly path: `/${string}`;
	}>;
	readonly invalid: Readonly<{
		readonly configPath: readonly PropertyKey[];
		readonly seedPath: readonly PropertyKey[];
	}>;
	readonly isolation: Readonly<{
		readonly expectedFresh: unknown;
		readonly expectedMutated: unknown;
		readonly mutate: ContractOperationCall<Services, ServiceKey>;
		readonly read: ContractOperationCall<Services, ServiceKey>;
	}>;
	readonly operations: readonly OperationContractFixture<Services, ServiceKey>[];
	readonly reset: Readonly<{
		readonly expectedEmpty: unknown;
		readonly expectedSeeded: unknown;
		readonly mutate: ContractOperationCall<Services, ServiceKey>;
		readonly read: ContractOperationCall<Services, ServiceKey>;
	}>;
	readonly serviceKey: ServiceKey;
	readonly trackedFetch: ContractDynamicInputFixture<Services, ServiceKey>;
}

/**
 * Declarative expectations plus one selected-plugin harness.
 *
 * The testkit owns runtime, instance, control, daemon, scenario, and assertion execution. The
 * harness remains a deliberate trust boundary: it must build every variant from the production
 * plugin factory and may only vary injected dependencies or versioned lifecycle behavior.
 */
export type PluginContractFixture<Services extends ServiceRecord> = {
	[ServiceKey in ContractServiceKey<Services>]: PluginContractFixtureBase<Services, ServiceKey>;
}[ContractServiceKey<Services>];
