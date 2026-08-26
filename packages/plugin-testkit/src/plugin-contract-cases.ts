import type { InstanceHandle, ServiceRecord } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import {
	assertContract,
	assertObservation,
	dataProperty,
	isPlainRecord,
	isRecordObject,
} from "./contract-assertions.js";
import type {
	ContractObservationProbe,
	InvalidConfigurationFixture,
	PluginContractCase,
	PluginContractFixture,
} from "./contract-types.js";

export function createPluginContractCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	validateFixture(fixture);
	return Object.freeze([
		observationCase(
			"authoring has no import or configuration side effects",
			fixture.authoring.sideEffects,
		),
		invalidConfigurationCase("invalid config reports its schema path", fixture.invalid.config),
		invalidConfigurationCase("invalid seed reports its schema path", fixture.invalid.seed),
		invalidConfigurationCase(
			"connection environment collisions identify the configuration path",
			fixture.invalid.environmentCollision,
		),
		observationCase(
			"lifecycle follows create/update/start/seed/stop order",
			fixture.lifecycle.ordering,
		),
		observationCase("create failure is recoverable", fixture.lifecycle.createFailureRecovery),
		observationCase("update failure is recoverable", fixture.lifecycle.updateFailureRecovery),
		Object.freeze({
			name: "operations validate, introspect, and expose unique CLI representations",
			run: () => operationContract(fixture),
		}),
		observationCase("invalid operation output is rejected", fixture.probes.outputValidation),
		Object.freeze({
			name: "simultaneous instances never share state",
			run: () => isolationContract(fixture),
		}),
		Object.freeze({
			name: "public Hono routes receive instance context",
			run: () => honoContract(fixture),
		}),
		observationCase("plugin storage rejects escape paths", fixture.probes.storageEscape),
		Object.freeze({
			name: "connections and environment values are instance-correct",
			run: () => connectionContract(fixture),
		}),
		Object.freeze({
			name: "tracked fetch work is drained by idle",
			run: () => trackedFetchContract(fixture),
		}),
		Object.freeze({
			name: "reset is empty and reset with seed applies once",
			run: () => resetContract(fixture),
		}),
		observationCase("state persists across runtime restart", fixture.durability.restartPersistence),
		observationCase("future stored state versions are rejected", fixture.durability.futureVersion),
		observationCase("state-version upgrades preserve data", fixture.durability.stateUpgrade),
	]);
}

export async function runPluginContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	for (const contractCase of createPluginContractCases(fixture)) await contractCase.run();
}

function observationCase(name: string, probe: ContractObservationProbe): PluginContractCase {
	return Object.freeze({
		name,
		run: async () => assertObservation(name, await probe()),
	});
}

function invalidConfigurationCase(
	name: string,
	fixture: InvalidConfigurationFixture,
): PluginContractCase {
	return Object.freeze({
		name,
		run: async () => {
			let runtime: TestRuntime<ServiceRecord> | undefined;
			let failure: unknown;
			try {
				const result = Reflect.apply(createTestRuntime, undefined, [
					{ config: fixture.create(), port: 0, storage: "temporary" },
				]);
				runtime = await result;
			} catch (cause) {
				failure = cause;
			} finally {
				await runtime?.close();
			}
			assertContract(failure !== undefined, name, "invalid configuration unexpectedly started");
			assertContract(
				hasIssuePath(failure, fixture.expectedPath),
				name,
				`missing issue path ${fixture.expectedPath}`,
			);
		},
	});
}

async function operationContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "operations validate, introspect, and expose unique CLI representations";
	await withInstance(fixture, async (runtime, instance) => {
		const instanceId = await onlyInstanceId(runtime, name);
		const description = await runtime.control.describeService(instanceId, fixture.world.serviceKey);
		assertContract(isPlainRecord(description), name, "service description must be an object");
		if (!isPlainRecord(description)) return;
		const metadata = dataProperty(description, "operationMetadata");
		assertContract(isPlainRecord(metadata), name, "operationMetadata must be an object");
		if (!isPlainRecord(metadata)) return;
		const expectedKeys = fixture.world.operations.map(({ key }) => key).sort();
		assertContract(
			isDeepEqual(Object.keys(metadata).sort(), expectedKeys),
			name,
			"operation fixture inventory must exactly match introspection",
		);
		const cliNames = new Set<string>();
		for (const operation of fixture.world.operations) {
			const operationMetadata = dataProperty(metadata, operation.key);
			assertContract(
				isPlainRecord(operationMetadata),
				name,
				`missing metadata for ${operation.key}`,
			);
			if (!isPlainRecord(operationMetadata)) continue;
			assertContract(
				typeof dataProperty(operationMetadata, "description") === "string",
				name,
				`${operation.key} has no description`,
			);
			assertContract(
				isPlainRecord(dataProperty(operationMetadata, "input")),
				name,
				`${operation.key} input is not introspectable`,
			);
			assertContract(
				isPlainRecord(dataProperty(operationMetadata, "output")),
				name,
				`${operation.key} output is not introspectable`,
			);
			const cli = dataProperty(operationMetadata, "cli");
			assertContract(
				isPlainRecord(cli) && dataProperty(cli, "kind") === operation.cli,
				name,
				`${operation.key} CLI representation differs`,
			);
			const cliName = toCliName(operation.key);
			assertContract(!cliNames.has(cliName), name, `duplicate CLI name ${cliName}`);
			cliNames.add(cliName);
			assertObservation(name, await operation.invoke(instance));
			await instance.idle();
			const invalidFailure = await runtime.control
				.executeOperation(instanceId, fixture.world.serviceKey, operation.key, null)
				.catch((cause: unknown) => cause);
			assertContract(
				errorCode(invalidFailure) === "INVALID_OPERATION_INPUT",
				name,
				`${operation.key} accepted null input`,
			);
		}
	});
}

async function isolationContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "simultaneous instances never share state";
	await withInstances(fixture, 2, async (_runtime, instances) => {
		const [first, second] = requireTwoInstances(instances);
		await fixture.probes.isolation.mutate(first);
		const [firstState, secondState] = await Promise.all([
			fixture.probes.isolation.read(first),
			fixture.probes.isolation.read(second),
		]);
		assertObservation(name, {
			actual: firstState,
			expected: fixture.probes.isolation.expectedMutated,
		});
		assertObservation(name, {
			actual: secondState,
			expected: fixture.probes.isolation.expectedFresh,
		});
	});
}

async function honoContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "public Hono routes receive instance context";
	await withInstance(fixture, async (_runtime, instance) => {
		assertObservation(name, await fixture.probes.honoContext(instance));
	});
}

async function connectionContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "connections and environment values are instance-correct";
	await withInstances(fixture, 2, async (runtime, instances) => {
		const [first, second] = requireTwoInstances(instances);
		const firstUrl = fixture.probes.connection.readUrl(first);
		const secondUrl = fixture.probes.connection.readUrl(second);
		assertContract(
			firstUrl.startsWith(`${runtime.connection.url}/`),
			name,
			"first URL does not use the bound runtime",
		);
		assertContract(
			secondUrl.startsWith(`${runtime.connection.url}/`),
			name,
			"second URL does not use the bound runtime",
		);
		assertContract(firstUrl !== secondUrl, name, "two instances produced the same connection URL");
		assertContract(
			first.env[fixture.probes.connection.environmentName] === firstUrl,
			name,
			"first env projection differs from connection",
		);
		assertContract(
			second.env[fixture.probes.connection.environmentName] === secondUrl,
			name,
			"second env projection differs from connection",
		);
		assertContract(
			Object.isFrozen(first.env) && Object.isFrozen(second.env),
			name,
			"environment projections are mutable",
		);
	});
}

async function trackedFetchContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "tracked fetch work is drained by idle";
	await withInstance(fixture, async (_runtime, instance) => {
		assertObservation(name, await fixture.probes.trackedFetchAndIdle(instance));
	});
}

async function resetContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "reset is empty and reset with seed applies once";
	await withInstance(fixture, async (_runtime, instance) => {
		await fixture.probes.reset.mutate(instance);
		await instance.reset();
		assertObservation(name, {
			actual: await fixture.probes.reset.read(instance),
			expected: fixture.probes.reset.expectedEmpty,
		});
		await instance.reset({ seed: true });
		assertObservation(name, {
			actual: await fixture.probes.reset.read(instance),
			expected: fixture.probes.reset.expectedSeeded,
		});
		const repeatedSeed = await instance.seed().catch((cause: unknown) => cause);
		assertContract(
			errorCode(repeatedSeed) === "LIFECYCLE_CONFLICT",
			name,
			"seed succeeded more than once after reset",
		);
	});
}

async function withInstance<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
	work: (runtime: TestRuntime<Services>, instance: InstanceHandle<Services>) => Promise<void>,
): Promise<void> {
	await withInstances(fixture, 1, async (runtime, instances) => {
		const instance = instances[0];
		if (!instance) throw new TypeError("Test world did not create its requested instance.");
		await work(runtime, instance);
	});
}

async function withInstances<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
	count: number,
	work: (
		runtime: TestRuntime<Services>,
		instances: readonly InstanceHandle<Services>[],
	) => Promise<void>,
): Promise<void> {
	const runtime = await testRuntime(fixture);
	const instances: InstanceHandle<Services>[] = [];
	let workFailure: unknown;
	try {
		for (let index = 0; index < count; index += 1) {
			instances.push(await runtime.createInstance());
		}
		await work(runtime, Object.freeze([...instances]));
	} catch (cause) {
		workFailure = cause;
	}
	const cleanupFailures: unknown[] = [];
	for (const result of await Promise.allSettled(instances.map((instance) => instance.destroy()))) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
	await runtime.close().catch((cause: unknown) => cleanupFailures.push(cause));
	if (workFailure !== undefined && cleanupFailures.length > 0) {
		throw new AggregateError(
			[workFailure, ...cleanupFailures],
			"Plugin contract case and cleanup failed.",
		);
	}
	if (workFailure !== undefined) throw workFailure;
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, "Plugin contract case cleanup failed.");
	}
}

function requireTwoInstances<Services extends ServiceRecord>(
	instances: readonly InstanceHandle<Services>[],
): readonly [InstanceHandle<Services>, InstanceHandle<Services>] {
	const first = instances[0];
	const second = instances[1];
	if (!first || !second) throw new TypeError("Test world did not create two instances.");
	return [first, second];
}

function testRuntime<Services extends ServiceRecord>(fixture: PluginContractFixture<Services>) {
	return createTestRuntime({ config: fixture.world.createConfig(), port: 0, storage: "temporary" });
}

async function onlyInstanceId<Services extends ServiceRecord>(
	runtime: TestRuntime<Services>,
	caseName: string,
): Promise<string> {
	const instances = await runtime.control.listInstances();
	assertContract(
		Array.isArray(instances) && instances.length === 1,
		caseName,
		"expected exactly one active instance",
	);
	const summary = Array.isArray(instances) ? instances[0] : undefined;
	assertContract(isPlainRecord(summary), caseName, "instance summary must be an object");
	const id = isPlainRecord(summary) ? dataProperty(summary, "id") : undefined;
	assertContract(typeof id === "string", caseName, "instance summary has no id");
	return typeof id === "string" ? id : "invalid";
}

function hasIssuePath(failure: unknown, expectedPath: string): boolean {
	if (!isRecordObject(failure)) return false;
	const details = dataProperty(failure, "details");
	if (!isPlainRecord(details)) return false;
	const issues = dataProperty(details, "issues");
	return (
		Array.isArray(issues) &&
		issues.some((issue) => isPlainRecord(issue) && dataProperty(issue, "path") === expectedPath)
	);
}

function errorCode(failure: unknown): unknown {
	return isRecordObject(failure) ? dataProperty(failure, "code") : undefined;
}

function validateFixture<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): void {
	if (!isPlainRecord(fixture))
		throw new TypeError("Plugin contract fixture must be a plain object.");
	if (fixture.world.operations.length === 0)
		throw new TypeError("Plugin contract fixture must exercise at least one operation.");
	const keys = new Set<string>();
	for (const operation of fixture.world.operations) {
		if (!/^[a-z][A-Za-z0-9]*$/.test(operation.key))
			throw new TypeError(`Invalid fixture operation key ${operation.key}.`);
		if (keys.has(operation.key))
			throw new TypeError(`Duplicate fixture operation ${operation.key}.`);
		keys.add(operation.key);
	}
}

function toCliName(value: string): string {
	return value
		.replace(/([a-z\d])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

function isDeepEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => right[index] === value);
}
