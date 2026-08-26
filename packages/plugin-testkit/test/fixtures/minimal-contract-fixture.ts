import { createServer } from "node:http";
import { Hono } from "hono";
import {
	defineConfig,
	defineOperation,
	definePlugin,
	type InstanceHandle,
	type PluginEnv,
} from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { z } from "zod";
import type { PluginContractFixture } from "../../src/index.js";
import {
	observeFutureVersionRejection,
	observeRestartPersistence,
	observeStateUpgrade,
	observeUpdateFailureRecovery,
} from "./durability-observations.js";
import { fixtureConfig, fixturePlugin } from "./fixture-plugin.js";

type Services = typeof fixtureConfig.services;
type Handle = InstanceHandle<Services>;

export const minimalContractFixture: PluginContractFixture<Services> = Object.freeze({
	authoring: Object.freeze({ sideEffects: observeAuthoringSideEffects }),
	durability: Object.freeze({
		futureVersion: observeFutureVersionRejection,
		restartPersistence: observeRestartPersistence,
		stateUpgrade: observeStateUpgrade,
	}),
	invalid: Object.freeze({
		config: Object.freeze({
			create: () => invalidFixtureConfig({ config: { label: 2137 }, seed: { value: 7 } }),
			expectedPath: "$.services.fixture.config.label",
		}),
		environmentCollision: Object.freeze({
			create: () => ({
				services: {
					first: fixturePlugin({ config: { label: "first" }, seed: { value: 1 } }),
					second: fixturePlugin({ config: { label: "second" }, seed: { value: 2 } }),
				},
			}),
			expectedPath: "$.services.second.$plugin.connection.env.FIXTURE_API_URL",
		}),
		seed: Object.freeze({
			create: () => invalidFixtureConfig({ config: { label: "valid" }, seed: { value: "bad" } }),
			expectedPath: "$.services.fixture.seed.value",
		}),
	}),
	lifecycle: Object.freeze({
		createFailureRecovery: observeCreateFailureRecovery,
		ordering: observeLifecycleOrdering,
		updateFailureRecovery: observeUpdateFailureRecovery,
	}),
	probes: Object.freeze({
		connection: Object.freeze({
			environmentName: "FIXTURE_API_URL",
			readUrl: (instance: Handle) => instance.fixture.connection.apiUrl,
		}),
		honoContext: observeHonoContext,
		isolation: Object.freeze({
			expectedFresh: 0,
			expectedMutated: 5,
			mutate: async (instance: Handle) => {
				await instance.fixture.increment({ by: 5 });
			},
			read: async (instance: Handle) => (await instance.fixture.read({})).value,
		}),
		outputValidation: observeOutputValidation,
		reset: Object.freeze({
			expectedEmpty: 0,
			expectedSeeded: 7,
			mutate: async (instance: Handle) => {
				await instance.fixture.increment({ by: 3 });
			},
			read: async (instance: Handle) => (await instance.fixture.read({})).value,
		}),
		storageEscape: observeStorageEscape,
		trackedFetchAndIdle: observeTrackedFetchAndIdle,
	}),
	world: Object.freeze({
		createConfig: () => fixtureConfig,
		operations: Object.freeze([
			Object.freeze({
				cli: "flags" as const,
				invoke: async (instance: Handle) =>
					observation(await instance.fixture.deliver({ url: "data:text/plain,ok" }), {
						queued: true,
					}),
				key: "deliver",
			}),
			Object.freeze({
				cli: "flags" as const,
				invoke: async (instance: Handle) =>
					observation(await instance.fixture.increment({ by: 2 }), {
						label: "isolated",
						value: 2,
					}),
				key: "increment",
			}),
			Object.freeze({
				cli: "flags" as const,
				invoke: async (instance: Handle) =>
					observation(await instance.fixture.read({}), { value: 2 }),
				key: "read",
			}),
		]),
		serviceKey: "fixture" as const,
	}),
});

async function observeHonoContext(instance: Handle) {
	const response = await fetch(`${instance.fixture.connection.apiUrl}/value`);
	const body: unknown = await response.json();
	const record = objectRecord(body);
	return observation(
		{
			hasInstanceId: typeof record.instanceId === "string" && record.instanceId.startsWith("test-"),
			label: record.label,
			status: response.status,
			value: record.value,
		},
		{ hasInstanceId: true, label: "isolated", status: 200, value: 0 },
	);
}

async function observeTrackedFetchAndIdle(instance: Handle) {
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
	if (!address || typeof address === "string")
		throw new Error("Fixture server has no TCP address.");
	try {
		await instance.fixture.deliver({ url: `http://127.0.0.1:${address.port}/delivery` });
		await entered.promise;
		let idleSettled = false;
		const idle = instance.idle().then(() => {
			idleSettled = true;
		});
		await Promise.resolve();
		const settledBeforeRelease = idleSettled;
		release.resolve();
		await idle;
		return observation(
			{ deliveries, settledBeforeRelease },
			{ deliveries: 1, settledBeforeRelease: false },
		);
	} finally {
		release.resolve();
		await new Promise<void>((resolve, reject) =>
			server.close((cause) => (cause ? reject(cause) : resolve())),
		);
	}
}

async function observeAuthoringSideEffects() {
	let lifecycleCalls = 0;
	const bind = defineOperation<"quiet", object, object>();
	const inspect = bind({
		description: "Inspect quiet plugin",
		input: z.object({}),
		output: z.object({ quiet: z.literal(true) }),
		run: (): { readonly quiet: true } => ({ quiet: true }),
	});
	const quiet = definePlugin({
		api: new Hono<PluginEnv<object, object>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "Quiet authoring probe",
		id: "quiet",
		lifecycle: {
			create: () => {
				lifecycleCalls += 1;
			},
			start: () => ({}),
		},
		operations: { inspect },
		stateVersion: 1,
	});
	quiet({ config: {} });
	return observation(lifecycleCalls, 0);
}

async function observeLifecycleOrdering() {
	const events: string[] = [];
	const config = lifecycleConfig(events);
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	const instance = await runtime.createInstance({ seed: true });
	await instance.destroy();
	await runtime.close();
	return observation(events, ["create", "start", "seed", "stop"]);
}

async function observeCreateFailureRecovery() {
	const events: string[] = [];
	let fail = true;
	const config = lifecycleConfig(events, () => {
		if (fail) {
			fail = false;
			throw new Error("injected create failure");
		}
	});
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	const failure = await runtime.createInstance().catch((cause: unknown) => cause);
	const recovered = await runtime.createInstance();
	await recovered.destroy();
	await runtime.close();
	return observation(
		{ events, failed: failure instanceof Error },
		{ events: ["create", "create", "start", "stop"], failed: true },
	);
}

function lifecycleConfig(events: string[], afterCreate: () => void = () => undefined) {
	type State = Readonly<{ ready: true }>;
	type Config = Readonly<Record<string, never>>;
	const bind = defineOperation<"lifecycle", State, Config>();
	const inspect = bind({
		description: "Inspect lifecycle state",
		input: z.object({}),
		output: z.object({ ready: z.literal(true) }),
		run: (context) => context.state,
	});
	const seedSchema = z.object({ ready: z.literal(true) });
	const plugin = definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "Lifecycle contract fixture",
		id: "lifecycle",
		lifecycle: {
			create: () => {
				events.push("create");
				afterCreate();
			},
			seed: () => {
				events.push("seed");
			},
			start: (): State => {
				events.push("start");
				return { ready: true };
			},
			stop: () => {
				events.push("stop");
			},
		},
		operations: { inspect },
		seedSchema,
		stateVersion: 1,
	});
	return defineConfig({
		services: { lifecycle: plugin({ config: {}, seed: { ready: true } }) },
	});
}

async function observeOutputValidation() {
	type State = Readonly<{ ready: true }>;
	type Config = Readonly<Record<string, never>>;
	const bind = defineOperation<"broken-output", State, Config>();
	const fail = bind({
		description: "Return a schema-invalid numeric value",
		input: z.object({}),
		output: z.object({ value: z.number() }),
		run: () => ({ value: Number.NaN }),
	});
	const plugin = definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "Output validation probe",
		id: "broken-output",
		lifecycle: { create: () => undefined, start: (): State => ({ ready: true }) },
		operations: { fail },
		stateVersion: 1,
	});
	const runtime = await createTestRuntime({
		config: defineConfig({ services: { broken: plugin({ config: {} }) } }),
		port: 0,
		storage: "temporary",
	});
	const instance = await runtime.createInstance();
	const failure = await instance.broken.fail({}).catch((cause: unknown) => cause);
	await instance.destroy();
	await runtime.close();
	return observation(errorCode(failure), "OPERATION_OUTPUT_INVALID");
}

async function observeStorageEscape() {
	type State = Readonly<{ escape(): string }>;
	type Config = Readonly<Record<string, never>>;
	const bind = defineOperation<"escape", State, Config>();
	const escapeOperation = bind({
		description: "Attempt an invalid storage path",
		input: z.object({}),
		output: z.object({ path: z.string() }),
		run: (context) => ({ path: context.state.escape() }),
	});
	const plugin = definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "Storage escape probe",
		id: "escape",
		lifecycle: {
			create: () => undefined,
			start: (context): State => ({ escape: () => context.storage.path("../escape") }),
		},
		operations: { escape: escapeOperation },
		stateVersion: 1,
	});
	const runtime = await createTestRuntime({
		config: defineConfig({ services: { escape: plugin({ config: {} }) } }),
		port: 0,
		storage: "temporary",
	});
	const instance = await runtime.createInstance();
	const failure = await instance.escape.escape({}).catch((cause: unknown) => cause);
	await instance.destroy();
	await runtime.close();
	return observation(errorCode(failure), "PLUGIN_EXECUTION_FAILED");
}

function invalidFixtureConfig(envelope: unknown): unknown {
	return {
		services: {
			fixture: Reflect.apply(fixturePlugin, undefined, [envelope]),
		},
	};
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Expected a response object.");
	}
	return value as Readonly<Record<string, unknown>>;
}

function errorCode(value: unknown): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, "code") : undefined;
}

function observation(actual: unknown, expected: unknown) {
	return Object.freeze({ actual, expected });
}

function deferred<Value>() {
	let resolvePromise: (value: Value | PromiseLike<Value>) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}
