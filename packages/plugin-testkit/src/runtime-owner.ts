import type { InstanceHandle, ServiceRecord } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import { assertContract, dataProperty, isPlainRecord } from "./contract-assertions.js";
import type {
	ContractHarnessVariant,
	ContractInstrumentation,
	ContractLifecycleEvent,
	PluginContractFixture,
} from "./contract-types.js";
import { assertSelectedServiceIdentity } from "./service-identity.js";

export interface OwnedRuntimeContext<Services extends ServiceRecord> {
	readonly ids: readonly string[];
	readonly instances: readonly InstanceHandle<Services>[];
	readonly runtime: TestRuntime<Services>;
}

export function lifecycleRecorder(): Readonly<{
	readonly events: string[];
	readonly instrumentation: ContractInstrumentation;
}> {
	const events: string[] = [];
	return Object.freeze({
		events,
		instrumentation: Object.freeze({
			record: (event: ContractLifecycleEvent) => events.push(event),
		}),
	});
}

export const quietInstrumentation: ContractInstrumentation = Object.freeze({
	record: (_event: ContractLifecycleEvent) => undefined,
});

export async function withOwnedInstances<Services extends ServiceRecord, Value>(
	fixture: PluginContractFixture<Services>,
	input: Readonly<{
		caseName: string;
		count: number;
		instrumentation?: ContractInstrumentation;
		seed?: boolean;
		variant?: ContractHarnessVariant;
	}>,
	work: (context: OwnedRuntimeContext<Services>) => Promise<Value>,
): Promise<Value> {
	const config = fixture.harness.createConfig({
		instrumentation: input.instrumentation ?? quietInstrumentation,
		variant: input.variant ?? "base",
	});
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	const instances: InstanceHandle<Services>[] = [];
	const outcome = await capture(async () => {
		for (let index = 0; index < input.count; index += 1) {
			instances.push(await runtime.createInstance({ seed: input.seed ?? false }));
		}
		const ids = await registeredInstanceIds(runtime, input.count, input.caseName);
		for (const id of ids) {
			await assertSelectedServiceIdentity(runtime.control, id, fixture, input.caseName);
		}
		return work(
			Object.freeze({
				ids,
				instances: Object.freeze([...instances]),
				runtime,
			}),
		);
	});
	const cleanupFailures: unknown[] = [];
	for (const result of await Promise.allSettled(instances.map((instance) => instance.destroy()))) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
	await runtime.close().catch((cause: unknown) => cleanupFailures.push(cause));
	return finishCaptured(outcome, cleanupFailures, "Plugin contract case");
}

export async function withOwnedRuntime<Services extends ServiceRecord, Value>(
	fixture: PluginContractFixture<Services>,
	input: Readonly<{
		instrumentation: ContractInstrumentation;
		variant: ContractHarnessVariant;
	}>,
	work: (runtime: TestRuntime<Services>) => Promise<Value>,
): Promise<Value> {
	const config = fixture.harness.createConfig(input);
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	const outcome = await capture(() => work(runtime));
	const cleanupFailures: unknown[] = [];
	await runtime.close().catch((cause: unknown) => cleanupFailures.push(cause));
	return finishCaptured(outcome, cleanupFailures, "Plugin contract case");
}

export async function registeredInstanceIds<Services extends ServiceRecord>(
	runtime: TestRuntime<Services>,
	expectedCount: number,
	caseName: string,
): Promise<readonly string[]> {
	const instances = await runtime.control.listInstances();
	assertContract(
		Array.isArray(instances) && instances.length === expectedCount,
		caseName,
		`expected exactly ${expectedCount} active instance(s)`,
	);
	if (!Array.isArray(instances)) return Object.freeze([]);
	return Object.freeze(
		instances.map((summary) => {
			assertContract(isPlainRecord(summary), caseName, "instance summary must be an object");
			const id = isPlainRecord(summary) ? dataProperty(summary, "id") : undefined;
			assertContract(typeof id === "string", caseName, "instance summary has no id");
			return typeof id === "string" ? id : "invalid";
		}),
	);
}

export type Captured<Value> =
	| Readonly<{ status: "fulfilled"; value: Value }>
	| Readonly<{ reason: unknown; status: "rejected" }>;

export async function capture<Value>(work: () => Promise<Value>): Promise<Captured<Value>> {
	try {
		return Object.freeze({ status: "fulfilled", value: await work() });
	} catch (reason) {
		return Object.freeze({ reason, status: "rejected" });
	}
}

export function finishCaptured<Value>(
	outcome: Captured<Value>,
	cleanupFailures: readonly unknown[],
	label: string,
): Value {
	if (outcome.status === "rejected" && cleanupFailures.length > 0) {
		throw new AggregateError([outcome.reason, ...cleanupFailures], `${label} and cleanup failed.`);
	}
	if (outcome.status === "rejected") throw outcome.reason;
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, `${label} cleanup failed.`);
	}
	return outcome.value;
}
