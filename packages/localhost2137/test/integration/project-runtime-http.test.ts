import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineConfig } from "../../src/authoring/config.js";
import type { PluginEnv, RunningPluginContext } from "../../src/authoring/context.js";
import { defineOperation } from "../../src/authoring/operation.js";
import { definePlugin } from "../../src/authoring/plugin.js";
import { resolveConfig } from "../../src/config/config-resolution.js";
import { NodeInstanceStorage } from "../../src/node/instance-storage.js";
import { nodeMonotonicClock } from "../../src/node/monotonic-clock.js";
import { createProjectRuntime } from "../../src/node/project-runtime.js";
import { nodeTaskScheduler } from "../../src/node/task-scheduler.js";
import { InstanceRuntimeCloseTimeoutError } from "../../src/kernel/persisted-instance-runtime.js";

const temporaryDirectories: string[] = [];
const CONTROL_TOKEN = "integration-control-token";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("project runtime HTTP composition", () => {
	it("shares state across operation/public paths and drains tracked fetch through idle", async () => {
		const delivery = deferred<Response>();
		const directory = await mkdtemp(join(tmpdir(), "localhost2137-http-runtime-"));
		temporaryDirectories.push(directory);
		const runtime = createProjectRuntime(fixtureConfig(directory), {
			controlToken: CONTROL_TOKEN,
			correlationId: sequence("correlation"),
			fetch: vi.fn(async () => delivery.promise),
			logLimits: { maxBytes: 100_000, maxEntries: 100 },
			monotonicClock: nodeMonotonicClock,
			scheduler: nodeTaskScheduler,
			storage: new NodeInstanceStorage(directory, { recoveryToken: sequence("recovery") }),
			time: fixedTime,
			token: sequence("token"),
		});
		const address = await runtime.server.start({ host: "127.0.0.1", port: 0 });
		await runtime.instances.create({
			id: "dev",
			persistence: "persistent",
			seed: false,
		});

		const increment = await controlFetch(
			`${address.url}/_/v1/instances/dev/services/fixture/operations/increment`,
			{},
		);
		const publicState = await fetch(`${address.url}/dev/fixture/state`);
		const queued = await controlFetch(
			`${address.url}/_/v1/instances/dev/services/fixture/operations/deliver`,
			{},
		);
		const idle = controlFetch(`${address.url}/_/v1/instances/dev/idle`, { timeoutMs: 1_000 });
		let idleFinished = false;
		void idle.then(() => {
			idleFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(await increment.json()).toEqual({ data: { count: 1 } });
		expect(await publicState.json()).toEqual({ count: 1, instanceId: "dev" });
		expect(await queued.json()).toEqual({ data: { queued: true } });
		expect(idleFinished).toBe(false);
		delivery.resolve(new Response(null, { status: 204 }));
		expect((await idle).status).toBe(200);

		const logs = await fetch(`${address.url}/_/v1/instances/dev/logs`, {
			headers: authorization(),
		});
		expect(JSON.stringify(await logs.json())).toContain('"kind":"delivery"');
		await runtime.server.close(1_000);
		await runtime.server.settled();
	});

	it("lets an admitted slow operation drain inside shutdown grace", async () => {
		const operationEntered = deferred<AbortSignal>();
		const releaseOperation = deferred<void>();
		const directory = await mkdtemp(join(tmpdir(), "localhost2137-http-grace-"));
		temporaryDirectories.push(directory);
		const runtime = createProjectRuntime(
			shutdownConfig(directory, async (context) => {
				operationEntered.resolve(context.signal);
				await releaseOperation.promise;
				context.signal.throwIfAborted();
			}),
			projectDependencies(
				directory,
				vi.fn(async () => new Response(null, { status: 204 })),
			),
		);
		const address = await runtime.server.start({ host: "127.0.0.1", port: 0 });
		await runtime.instances.create({ id: "dev", persistence: "persistent", seed: false });
		const operation = controlFetch(
			`${address.url}/_/v1/instances/dev/services/fixture/operations/slow`,
			{},
		);
		const operationSignal = await operationEntered.promise;

		const closing = runtime.server.close(1_000);
		expect(operationSignal.aborted).toBe(false);
		await expect(runtime.instances.list()).rejects.toThrow("closing or already closed");
		releaseOperation.resolve(undefined);

		expect((await operation).status).toBe(200);
		await expect(closing).resolves.toBeUndefined();
		await expect(runtime.server.settled()).resolves.toBeUndefined();
	});

	it("aborts a retained operation and fetch only after shutdown grace expires", async () => {
		const fetchEntered = deferred<AbortSignal>();
		const directory = await mkdtemp(join(tmpdir(), "localhost2137-http-grace-timeout-"));
		temporaryDirectories.push(directory);
		const outboundFetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const signal = init?.signal;
				if (!signal) throw new Error("Expected the runtime fetch signal.");
				fetchEntered.resolve(signal);
				return await new Promise<Response>((_resolve, reject) => {
					const aborted = () => reject(signal.reason);
					signal.addEventListener("abort", aborted, { once: true });
					if (signal.aborted) aborted();
				});
			},
		);
		const runtime = createProjectRuntime(
			shutdownConfig(directory, async (context) => {
				await context.fetch("https://callback.example.test/slow");
			}),
			projectDependencies(directory, outboundFetch),
		);
		const address = await runtime.server.start({ host: "127.0.0.1", port: 0 });
		await runtime.instances.create({ id: "dev", persistence: "persistent", seed: false });
		const operation = controlFetch(
			`${address.url}/_/v1/instances/dev/services/fixture/operations/slow`,
			{},
		);
		const fetchSignal = await fetchEntered.promise;

		const closing = runtime.server.close(25);
		expect(fetchSignal.aborted).toBe(false);
		const closeFailure = await closing.catch((cause: unknown) => cause);

		expect(closeFailure).toBeInstanceOf(AggregateError);
		const runtimeTimeout = (closeFailure as AggregateError).errors.find(
			(cause) => cause instanceof InstanceRuntimeCloseTimeoutError,
		);
		expect(runtimeTimeout).toMatchObject({
			activeAdmissions: 1,
			unfinishedTaskLabels: [expect.stringMatching(/^dev:fetch:fixture:/)],
		});
		expect(fetchSignal.aborted).toBe(true);
		expect([499, 500]).toContain((await operation).status);
		await expect(runtime.server.settled()).rejects.toBeInstanceOf(AggregateError);
	});
});

function projectDependencies(
	directory: string,
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	return {
		controlToken: CONTROL_TOKEN,
		correlationId: sequence("correlation"),
		fetch,
		logLimits: { maxBytes: 100_000, maxEntries: 100 },
		monotonicClock: nodeMonotonicClock,
		scheduler: nodeTaskScheduler,
		storage: new NodeInstanceStorage(directory, { recoveryToken: sequence("recovery") }),
		time: fixedTime,
		token: sequence("token"),
	};
}

function shutdownConfig(
	directory: string,
	run: (
		context: RunningPluginContext<Record<string, never>, Record<string, never>>,
	) => Promise<void>,
) {
	type State = Record<string, never>;
	type Config = Record<string, never>;
	const operation = defineOperation<"fixture", State, Config>()({
		description: "slow shutdown fixture",
		input: z.object({}),
		output: z.object({ done: z.literal(true) }),
		run: async (context) => {
			await run(context);
			return { done: true as const };
		},
	});
	const plugin = definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "shutdown fixture",
		id: "fixture",
		lifecycle: { create: () => undefined, start: () => ({}) },
		operations: { slow: operation },
		stateVersion: 1,
	});
	return resolveConfig(
		defineConfig({
			services: { fixture: plugin({ config: {} }) },
			storage: { dir: directory },
		}),
		join(directory, "localhost.config.ts"),
	);
}

function fixtureConfig(directory: string) {
	type State = { count: number };
	type Config = Record<string, never>;
	const operation = defineOperation<"fixture", State, Config>();
	const increment = operation({
		description: "increment state",
		input: z.object({}),
		output: z.object({ count: z.number() }),
		run: (context) => ({ count: ++context.state.count }),
	});
	const deliver = operation({
		description: "queue delivery",
		input: z.object({}),
		output: z.object({ queued: z.literal(true) }),
		run: (context) => {
			void context.fetch("https://callback.example.test/events", { method: "POST" });
			return { queued: true as const };
		},
	});
	const api = new Hono<PluginEnv<State, Config>>();
	api.get("/state", (context) => {
		const runtime = context.get("lh");
		return context.json({ count: runtime.state.count, instanceId: runtime.instanceId });
	});
	const plugin = definePlugin({
		api,
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "fixture",
		id: "fixture",
		lifecycle: { create: () => undefined, start: () => ({ count: 0 }) },
		operations: { deliver, increment },
		stateVersion: 1,
	});
	return resolveConfig(
		defineConfig({
			services: { fixture: plugin({ config: {} }) },
			storage: { dir: directory },
		}),
		join(directory, "localhost.config.ts"),
	);
}

async function controlFetch(url: string, body: unknown): Promise<Response> {
	return await fetch(url, {
		body: JSON.stringify(body),
		headers: { ...authorization(), "content-type": "application/json" },
		method: "POST",
	});
}

function authorization(): Readonly<Record<string, string>> {
	return { authorization: `Bearer ${CONTROL_TOKEN}` };
}

function sequence(prefix: string): () => string {
	let value = 0;
	return () => `${prefix}${String(++value).padStart(12, "0")}`;
}

const fixedTime = Object.freeze({
	nowMilliseconds: () => Date.parse("2026-08-25T12:00:00.000Z"),
	nowTimestamp: () => "2026-08-25T12:00:00.000Z",
});

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}
