import type { ServiceRecord } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import {
	assertContract,
	assertContractEqual,
	dataProperty,
	errorCode,
	isPlainRecord,
	isRecordObject,
} from "./contract-assertions.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";
import { collisionServiceKeys, issuePath } from "./fixture-validation.js";
import {
	lifecycleRecorder,
	quietInstrumentation,
	registeredInstanceIds,
	withOwnedInstances,
	withOwnedRuntime,
} from "./runtime-owner.js";
import { assertSelectedServiceIdentity } from "./service-identity.js";

export function lifecycleFaultCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	return Object.freeze([
		contractCase("invalid config reports its schema path", () =>
			invalidSelectedServiceCase(fixture, "config"),
		),
		contractCase("invalid seed reports its schema path", () =>
			invalidSelectedServiceCase(fixture, "seed"),
		),
		contractCase("connection environment collisions identify the configuration path", () =>
			collisionCase(fixture),
		),
		contractCase("lifecycle follows create/update/start/seed/stop order", () =>
			lifecycleOrderingCase(fixture),
		),
		contractCase("create failure is recoverable", () => createRecoveryCase(fixture)),
		contractCase("invalid operation output is rejected", () => outputValidationCase(fixture)),
		contractCase("plugin storage rejects escape paths", () => storageEscapeCase(fixture)),
	]);
}

async function invalidSelectedServiceCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
	kind: "config" | "seed",
): Promise<void> {
	const name =
		kind === "config"
			? "invalid config reports its schema path"
			: "invalid seed reports its schema path";
	const config = fixture.harness.createInvalidConfig(kind);
	const expectedPath = issuePath([
		"services",
		fixture.serviceKey,
		kind,
		...(kind === "config" ? fixture.invalid.configPath : fixture.invalid.seedPath),
	]);
	await expectConfigInvalid(config, name, (issue) => dataProperty(issue, "path") === expectedPath);
}

async function collisionCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "connection environment collisions identify the configuration path";
	const [first, second] = collisionServiceKeys(fixture.serviceKey);
	const config = {
		services: {
			[first]: fixture.harness.createService(),
			[second]: fixture.harness.createService(),
		},
	};
	const expectedPath = issuePath([
		"services",
		second,
		"$plugin",
		"connection",
		"env",
		fixture.connection.environmentName,
	]);
	await expectConfigInvalid(config, name, (issue) => {
		const message = dataProperty(issue, "message");
		return (
			dataProperty(issue, "code") === "env_collision" &&
			dataProperty(issue, "path") === expectedPath &&
			dataProperty(issue, "serviceKey") === second &&
			typeof message === "string" &&
			message.includes(`"${first}"`) &&
			message.includes(`"${second}"`) &&
			message.includes(`"${fixture.connection.environmentName}"`)
		);
	});
}

async function lifecycleOrderingCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "lifecycle follows create/update/start/seed/stop order";
	const recorder = lifecycleRecorder();
	await withOwnedRuntime(
		fixture,
		{ instrumentation: recorder.instrumentation, variant: "base" },
		async (runtime) => {
			const instance = await runtime.createInstance({ seed: true });
			const [id] = await registeredInstanceIds(runtime, 1, name);
			if (!id) throw new TypeError("Contract runtime did not register its instance.");
			await assertSelectedServiceIdentity(runtime.control, id, fixture, name);
			await instance.destroy();
		},
	);
	assertContractEqual(recorder.events, ["create", "start", "seed", "stop"], name);
}

async function createRecoveryCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "create failure is recoverable";
	const recorder = lifecycleRecorder();
	await withOwnedRuntime(
		fixture,
		{ instrumentation: recorder.instrumentation, variant: "create-fails-once" },
		async (runtime) => {
			const firstFailure = await runtime.createInstance().catch((cause: unknown) => cause);
			assertContract(firstFailure instanceof Error, name, "injected create failure did not reject");
			const recovered = await runtime.createInstance();
			const [id] = await registeredInstanceIds(runtime, 1, name);
			if (!id) throw new TypeError("Recovered runtime did not register its instance.");
			await assertSelectedServiceIdentity(runtime.control, id, fixture, name);
			await recovered.destroy();
		},
	);
	assertContractEqual(recorder.events, ["create", "create", "start", "stop"], name);
}

async function outputValidationCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "invalid operation output is rejected";
	await withOwnedInstances(
		fixture,
		{ caseName: name, count: 1, variant: "invalid-output" },
		async ({ ids, runtime }) => {
			const id = ids[0];
			if (!id) throw new TypeError("Contract runtime did not register its instance.");
			const call = fixture.faults.invalidOutput;
			const failure = await runtime.control
				.executeOperation(id, fixture.serviceKey, call.operation, call.input as never)
				.catch((cause: unknown) => cause);
			assertContract(
				errorCode(failure) === "OPERATION_OUTPUT_INVALID",
				name,
				"selected operation did not reject its invalid output",
			);
		},
	);
}

async function storageEscapeCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "plugin storage rejects escape paths";
	await withOwnedInstances(
		fixture,
		{ caseName: name, count: 1, variant: "storage-escape" },
		async ({ ids, runtime }) => {
			const id = ids[0];
			if (!id) throw new TypeError("Contract runtime did not register its instance.");
			const call = fixture.faults.storageEscape;
			const failure = await runtime.control
				.executeOperation(id, fixture.serviceKey, call.operation, call.input as never)
				.catch((cause: unknown) => cause);
			assertContract(
				errorCode(failure) === "PLUGIN_EXECUTION_FAILED",
				name,
				"selected operation did not reject a storage escape",
			);
		},
	);
}

async function expectConfigInvalid(
	config: unknown,
	caseName: string,
	issueMatches: (issue: Readonly<Record<PropertyKey, unknown>>) => boolean,
): Promise<void> {
	let runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
	let failure: unknown;
	try {
		const result = Reflect.apply(createTestRuntime, undefined, [
			{ config, port: 0, storage: "temporary" },
		]);
		runtime = await result;
	} catch (cause) {
		failure = cause;
	}
	if (runtime) {
		const assertion = new Error(`${caseName}: invalid configuration unexpectedly started`);
		await runtime.close().catch((cause: unknown) => {
			throw new AggregateError([assertion, cause], "Invalid configuration and cleanup failed.");
		});
		throw assertion;
	}
	assertContract(
		errorCode(failure) === "CONFIG_INVALID",
		caseName,
		"failure was not CONFIG_INVALID",
	);
	assertContract(
		hasIssue(failure, issueMatches),
		caseName,
		"expected configuration issue was missing",
	);
}

function hasIssue(
	failure: unknown,
	matches: (issue: Readonly<Record<PropertyKey, unknown>>) => boolean,
): boolean {
	if (!isRecordObject(failure)) return false;
	const details = dataProperty(failure, "details");
	if (!isPlainRecord(details)) return false;
	const issues = dataProperty(details, "issues");
	return Array.isArray(issues) && issues.some((issue) => isPlainRecord(issue) && matches(issue));
}

function contractCase(name: string, run: () => Promise<void>): PluginContractCase {
	return Object.freeze({ name, run });
}
