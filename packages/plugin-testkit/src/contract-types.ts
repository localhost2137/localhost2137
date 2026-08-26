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

export interface ContractHarnessResources {
	readonly deliveryUrl: string;
}

export interface ContractHarnessConfigOptions {
	readonly instrumentation: ContractInstrumentation;
	readonly resources: ContractHarnessResources;
	readonly variant: ContractHarnessVariant;
}

export interface SelectedPluginHarness<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	/** Build the selected service through the same production plugin factory used by every variant. */
	createConfig(options: ContractHarnessConfigOptions): RuntimeConfig<Services>;
	/** Build an intentionally invalid selected-service envelope. This pre-readiness variant is trusted. */
	createInvalidConfig(kind: "config" | "seed", resources: ContractHarnessResources): unknown;
	/** Build one base service so the testkit can mount the same family twice for collision checks. */
	createService(resources: ContractHarnessResources): Services[ServiceKey];
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
	/** Public operations run exactly once before the first daemon's baseline read/write. */
	readonly arrange: readonly ContractOperationCall<Services, ServiceKey>[];
	/** A file URL for a CLI config module using the documented contract-test environment variables. */
	readonly configModule: URL;
	readonly expectedInitial: unknown;
	readonly expectedPersisted: unknown;
	readonly expectedWrite: unknown;
	readonly read: ContractOperationCall<Services, ServiceKey>;
	/** Optional abrupt-process proof for durable work reconciled during lifecycle.onStarted. */
	readonly startupRecovery?: ContractStartupRecoveryDurabilityFixture<Services, ServiceKey>;
	/**
	 * Optional real-process proof for plugins that reconcile durable state after virtual time moves.
	 * The daemon config must use the exported time-advance fixture protocol when the fault is enabled.
	 */
	readonly timeAdvance?: ContractTimeAdvanceDurabilityFixture<Services, ServiceKey>;
	readonly versions: Readonly<{
		current: number;
		future: number;
		old: number;
	}>;
	readonly write: ContractOperationCall<Services, ServiceKey>;
}

export interface ContractStartupRecoveryDurabilityFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	/** Public operations that commit state and begin at least one held remote delivery. */
	readonly arrange: readonly ContractOperationCall<Services, ServiceKey>[];
	readonly deliveries: Readonly<{
		readonly afterInterruption: number;
		readonly afterRecovery: number;
	}>;
	/** Each observation is asserted after restart to reject duplicate durable effects. */
	readonly observations: readonly Readonly<{
		readonly expected: unknown;
		readonly read: ContractOperationCall<Services, ServiceKey>;
	}>[];
}

export interface ContractTimeAdvanceDurabilityFixture<
	Services extends ServiceRecord,
	ServiceKey extends ContractServiceKey<Services>,
> {
	/** Public operations that create state due for reconciliation. */
	readonly arrange: readonly ContractOperationCall<Services, ServiceKey>[];
	/** Expected receiver call counts at each transaction/recovery boundary. */
	readonly deliveries: Readonly<{
		readonly afterArrange: number;
		readonly afterCommittedAdvance: number;
		readonly afterRecovery: number;
	}>;
	readonly duration: string;
	/** Each observation is asserted after commit and again after restart to reject duplicate effects. */
	readonly observations: readonly Readonly<{
		readonly expected: unknown;
		readonly read: ContractOperationCall<Services, ServiceKey>;
	}>[];
}

export interface ContractHttpRequestDescriptor {
	readonly body?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	readonly responseBody: "json" | "text";
	readonly url: string;
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
		readonly arrange: Readonly<{
			readonly first: Readonly<{
				expected: unknown;
				invoke: ContractOperationCall<Services, ServiceKey>;
			}>;
			readonly second: Readonly<{
				expected: unknown;
				invoke: ContractOperationCall<Services, ServiceKey>;
			}>;
		}>;
		readonly expected: Readonly<{
			readonly first: Readonly<{ data: unknown; status: number }>;
			readonly second: Readonly<{ data: unknown; status: number }>;
		}>;
		normalize(responseBody: unknown): unknown;
		request(
			connection: InstanceHandle<Services>[ServiceKey]["connection"],
		): ContractHttpRequestDescriptor;
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
	readonly trackedFetch: Readonly<{
		readonly arrange: readonly ContractOperationCall<Services, ServiceKey>[];
		readonly expected: unknown;
		readonly invoke: ContractOperationCall<Services, ServiceKey>;
	}>;
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
