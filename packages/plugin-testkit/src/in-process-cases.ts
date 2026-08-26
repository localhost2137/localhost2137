import { createServer } from "node:http";
import type { ServiceRecord } from "localhost2137";
import {
	assertContract,
	assertContractEqual,
	dataProperty,
	errorCode,
	isPlainRecord,
} from "./contract-assertions.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";
import { withOwnedInstances } from "./runtime-owner.js";
import { assertSelectedServiceIdentity } from "./service-identity.js";

export function inProcessCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	return Object.freeze([
		contractCase("operations validate, introspect, and expose unique CLI representations", () =>
			operationContract(fixture),
		),
		contractCase("simultaneous instances never share state", () => isolationContract(fixture)),
		contractCase("public Hono routes receive instance context", () => honoContract(fixture)),
		contractCase("connections and environment values are instance-correct", () =>
			connectionContract(fixture),
		),
		contractCase("tracked fetch work is drained by idle", () => trackedFetchContract(fixture)),
		contractCase("reset is empty and reset with seed applies once", () => resetContract(fixture)),
	]);
}

async function operationContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "operations validate, introspect, and expose unique CLI representations";
	await withOwnedInstances(fixture, { caseName: name, count: 1 }, async ({ ids, runtime }) => {
		const id = requireItem(ids, 0);
		const metadata = await assertSelectedServiceIdentity(runtime.control, id, fixture, name);
		const cliNames = new Set<string>();
		for (const operation of fixture.operations) {
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
			assertContractEqual(
				await runtime.control.executeOperation(
					id,
					fixture.serviceKey,
					operation.key,
					operation.input as never,
				),
				operation.expected,
				name,
			);
			await runtime.control.idle(id);
			const invalidFailure = await runtime.control
				.executeOperation(id, fixture.serviceKey, operation.key, null)
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
	await withOwnedInstances(fixture, { caseName: name, count: 2 }, async ({ ids, runtime }) => {
		const first = requireItem(ids, 0);
		const second = requireItem(ids, 1);
		await execute(runtime.control, first, fixture, fixture.isolation.mutate);
		const [mutated, fresh] = await Promise.all([
			execute(runtime.control, first, fixture, fixture.isolation.read),
			execute(runtime.control, second, fixture, fixture.isolation.read),
		]);
		assertContractEqual(mutated, fixture.isolation.expectedMutated, name);
		assertContractEqual(fresh, fixture.isolation.expectedFresh, name);
	});
}

async function honoContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "public Hono routes receive instance context";
	await withOwnedInstances(fixture, { caseName: name, count: 1 }, async ({ instances }) => {
		const connection = selectedConnection(requireItem(instances, 0), fixture.serviceKey);
		const baseUrl = dataProperty(connection, fixture.connection.valueKey);
		assertContract(typeof baseUrl === "string", name, "selected connection URL is missing");
		if (typeof baseUrl !== "string") return;
		const response = await fetch(`${baseUrl}${fixture.hono.path}`);
		const body: unknown = await response.json();
		assertContractEqual(response.status, fixture.hono.expectedStatus, name);
		assertContractEqual(body, fixture.hono.expectedBody, name);
	});
}

async function connectionContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "connections and environment values are instance-correct";
	await withOwnedInstances(
		fixture,
		{ caseName: name, count: 2 },
		async ({ ids, instances, runtime }) => {
			const first = requireItem(instances, 0);
			const second = requireItem(instances, 1);
			const firstUrl = dataProperty(
				selectedConnection(first, fixture.serviceKey),
				fixture.connection.valueKey,
			);
			const secondUrl = dataProperty(
				selectedConnection(second, fixture.serviceKey),
				fixture.connection.valueKey,
			);
			assertContract(typeof firstUrl === "string", name, "first connection URL is missing");
			assertContract(typeof secondUrl === "string", name, "second connection URL is missing");
			if (typeof firstUrl !== "string" || typeof secondUrl !== "string") return;
			const firstId = connectionInstanceId(
				firstUrl,
				runtime.connection.url,
				fixture.serviceKey,
				ids,
			);
			const secondId = connectionInstanceId(
				secondUrl,
				runtime.connection.url,
				fixture.serviceKey,
				ids,
			);
			assertContract(
				firstId !== undefined,
				name,
				"first URL is not rooted at its registered service",
			);
			assertContract(
				secondId !== undefined,
				name,
				"second URL is not rooted at its registered service",
			);
			assertContract(
				firstId !== secondId,
				name,
				"two handles resolved to the same registered instance",
			);
			assertContract(
				first.env[fixture.connection.environmentName] === firstUrl,
				name,
				"first env projection differs from connection",
			);
			assertContract(
				second.env[fixture.connection.environmentName] === secondUrl,
				name,
				"second env projection differs from connection",
			);
			assertContract(
				Object.isFrozen(first.env) && Object.isFrozen(second.env),
				name,
				"environment projections are mutable",
			);
		},
	);
}

async function trackedFetchContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "tracked fetch work is drained by idle";
	await withOwnedInstances(fixture, { caseName: name, count: 1 }, async ({ ids, runtime }) => {
		const entered = deferred<void>();
		const release = deferred<void>();
		let deliveries = 0;
		const server = createServer(async (_request, response) => {
			deliveries += 1;
			entered.resolve();
			await release.promise;
			response.writeHead(204).end();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0 }, resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Contract delivery server has no TCP address.");
		}
		let scenarioFailure: unknown;
		let didFail = false;
		try {
			const id = requireItem(ids, 0);
			const actual = await runtime.control.executeOperation(
				id,
				fixture.serviceKey,
				fixture.trackedFetch.operation,
				fixture.trackedFetch.input(`http://127.0.0.1:${address.port}/delivery`) as never,
			);
			assertContractEqual(actual, fixture.trackedFetch.expected, name);
			await entered.promise;
			let idleSettled = false;
			const idle = runtime.control.idle(id).then(() => {
				idleSettled = true;
			});
			await Promise.resolve();
			assertContract(!idleSettled, name, "idle settled before tracked fetch completed");
			release.resolve();
			await idle;
			assertContractEqual(deliveries, 1, name);
		} catch (cause) {
			didFail = true;
			scenarioFailure = cause;
		}
		release.resolve();
		const closeFailure = await new Promise<unknown>((resolve) =>
			server.close((cause) => resolve(cause)),
		);
		if (didFail && closeFailure) {
			throw new AggregateError(
				[scenarioFailure, closeFailure],
				"Tracked fetch case and server cleanup failed.",
			);
		}
		if (didFail) throw scenarioFailure;
		if (closeFailure) throw closeFailure;
	});
}

async function resetContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "reset is empty and reset with seed applies once";
	await withOwnedInstances(fixture, { caseName: name, count: 1 }, async ({ ids, runtime }) => {
		const id = requireItem(ids, 0);
		await execute(runtime.control, id, fixture, fixture.reset.mutate);
		await runtime.control.resetInstance(id);
		await assertSelectedServiceIdentity(runtime.control, id, fixture, name);
		assertContractEqual(
			await execute(runtime.control, id, fixture, fixture.reset.read),
			fixture.reset.expectedEmpty,
			name,
		);
		await runtime.control.resetInstance(id, { seed: true });
		await assertSelectedServiceIdentity(runtime.control, id, fixture, name);
		assertContractEqual(
			await execute(runtime.control, id, fixture, fixture.reset.read),
			fixture.reset.expectedSeeded,
			name,
		);
		const repeatedSeed = await runtime.control.seedInstance(id).catch((cause: unknown) => cause);
		assertContract(
			errorCode(repeatedSeed) === "LIFECYCLE_CONFLICT",
			name,
			"seed succeeded more than once after reset",
		);
	});
}

async function execute<Services extends ServiceRecord>(
	control: Readonly<{
		executeOperation(
			id: string,
			service: string,
			operation: string,
			input: never,
		): Promise<unknown>;
	}>,
	id: string,
	fixture: PluginContractFixture<Services>,
	call: Readonly<{ input: unknown; operation: string }>,
): Promise<unknown> {
	return control.executeOperation(id, fixture.serviceKey, call.operation, call.input as never);
}

function selectedConnection(
	instance: unknown,
	serviceKey: string,
): Readonly<Record<PropertyKey, unknown>> {
	if (!isPlainRecord(instance)) throw new TypeError("Instance handle must be an object.");
	const service = dataProperty(instance, serviceKey);
	if (!isPlainRecord(service)) throw new TypeError("Selected service handle is missing.");
	const connection = dataProperty(service, "connection");
	if (!isPlainRecord(connection)) throw new TypeError("Selected service connection is missing.");
	return connection;
}

function requireItem<Value>(values: readonly Value[], index: number): Value {
	const value = values[index];
	if (value === undefined)
		throw new TypeError("Contract runtime did not create the expected item.");
	return value;
}

function connectionInstanceId(
	value: string,
	runtimeUrl: string,
	serviceKey: string,
	instanceIds: readonly string[],
): string | undefined {
	try {
		const runtime = new URL(runtimeUrl);
		const connection = new URL(value);
		if (connection.origin !== runtime.origin) return undefined;
		const runtimePath = runtime.pathname.endsWith("/") ? runtime.pathname : `${runtime.pathname}/`;
		if (!connection.pathname.startsWith(runtimePath)) return undefined;
		const [instanceId, selectedService] = connection.pathname.slice(runtimePath.length).split("/");
		return selectedService === serviceKey && instanceId && instanceIds.includes(instanceId)
			? instanceId
			: undefined;
	} catch {
		return undefined;
	}
}

function toCliName(value: string): string {
	return value
		.replace(/([a-z\d])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

function deferred<Value>() {
	let resolvePromise: (value: Value | PromiseLike<Value>) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}

function contractCase(name: string, run: () => Promise<void>): PluginContractCase {
	return Object.freeze({ name, run });
}
