import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineConfig } from "../../src/authoring/config.js";
import type { RunningPluginContext } from "../../src/authoring/context.js";
import { defineOperation } from "../../src/authoring/operation.js";
import { definePlugin } from "../../src/authoring/plugin.js";
import { resolveConfig } from "../../src/config/config-resolution.js";
import { createScenarioSeedFactory } from "../../src/config/scenario-seed-runtime.js";
import { OperationRunner } from "../../src/kernel/operation-executor.js";
import type { AnyServiceLifecycle } from "../../src/kernel/service-lifecycle.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";

describe("createScenarioSeedFactory", () => {
	it("runs scenario operations through the common runner in the existing scope", async () => {
		const calls: string[] = [];
		type State = { readonly prefix: string };
		type Config = { readonly suffix: string };
		const operation = defineOperation<"fixture", State, Config>()({
			description: "record a name",
			input: z.object({ name: z.string() }),
			output: z.object({ value: z.string() }),
			run: (context, input) => {
				const value = `${context.state.prefix}:${input.name}:${context.config.suffix}`;
				calls.push(value);
				return { value };
			},
		});
		const plugin = definePlugin({
			api: new Hono(),
			configSchema: z.object({ suffix: z.string() }),
			connection: ({ instanceId }) => ({
				env: {},
				values: { instanceUrl: `http://example.test/${instanceId}` },
			}),
			description: "fixture",
			id: "fixture",
			lifecycle: { create: () => undefined, start: () => ({ prefix: "state" }) },
			operations: { record: operation },
			stateVersion: 1,
		});
		const config = resolveConfig(
			defineConfig({
				port: 42137,
				seed: async (scenario) => {
					expect(scenario.fixture.connection.instanceUrl).toBe("http://example.test/review");
					expect(await scenario.fixture.record({ name: "Ada" })).toEqual({
						value: "state:Ada:configured",
					});
				},
				services: { fixture: plugin({ config: { suffix: "configured" } }) },
			}),
			"/project/localhost.config.ts",
		);
		const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
		const runner = new OperationRunner({
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});
		const factory = createScenarioSeedFactory(config, runner, () => "correlation-1");
		const signal = new AbortController().signal;
		const service = fixtureService(runningContext(signal));

		await factory?.({ instanceId: "review", logs, services: [service] })?.run(signal);

		expect(calls).toEqual(["state:Ada:configured"]);
		expect(logs.snapshot().entries.map(({ kind, status }) => `${kind}:${status}`)).toEqual([
			"operation:started",
			"operation:succeeded",
		]);
	});

	it("does not create a facade when no top-level seed is configured", () => {
		const config = resolveConfig(defineConfig({ services: {} }), "/project/localhost.config.ts");
		const runner = new OperationRunner({
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});

		expect(createScenarioSeedFactory(config, runner, () => "correlation-1")).toBeUndefined();
	});

	it("closes captured facades and drains unawaited operations without unhandled rejection", async () => {
		const gate = deferred<void>();
		const operationFailure = new Error("owned scenario failure");
		let operationCalls = 0;
		let capturedOperation: ((input: object) => Promise<unknown>) | undefined;
		const operation = defineOperation<"fixture", object, object>()({
			description: "fail after a gate",
			input: z.object({}),
			output: z.null(),
			run: async () => {
				operationCalls += 1;
				await gate.promise;
				throw operationFailure;
			},
		});
		const plugin = definePlugin({
			api: new Hono(),
			configSchema: z.object({}),
			connection: () => ({ env: {}, values: {} }),
			description: "fixture",
			id: "fixture",
			lifecycle: { create: () => undefined, start: () => ({}) },
			operations: { fail: operation },
			stateVersion: 1,
		});
		const config = resolveConfig(
			defineConfig({
				seed: async (scenario) => {
					capturedOperation = scenario.fixture.fail;
					void scenario.fixture.fail({});
				},
				services: { fixture: plugin({ config: {} }) },
			}),
			"/project/localhost.config.ts",
		);
		const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
		const runner = new OperationRunner({
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});
		const factory = createScenarioSeedFactory(config, runner, () => "scenario-correlation");
		const signal = new AbortController().signal;
		const service = fixtureService(runningContext(signal));

		const seed = factory?.({ instanceId: "review", logs, services: [service] })?.run(signal);
		await vi.waitFor(() => expect(operationCalls).toBe(1));
		gate.resolve();

		const seedFailure = await seed?.catch((cause: unknown) => cause);
		expect(seedFailure).toMatchObject({ code: "PLUGIN_EXECUTION_FAILED" });
		expect(Reflect.get(seedFailure as object, "cause")).toBe(operationFailure);
		await expect(capturedOperation?.({})).rejects.toMatchObject({
			name: "ScenarioOperationScopeClosedError",
		});
		expect(operationCalls).toBe(1);
		expect(logs.snapshot().entries.map(({ correlationId }) => correlationId)).toEqual([
			"scenario-correlation",
			"scenario-correlation",
		]);
	});
});

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	reject: (cause?: unknown) => void;
	resolve: (value: Value) => void;
}> {
	let resolve!: (value: Value) => void;
	let reject!: (cause?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function runningContext(signal: AbortSignal): RunningPluginContext<unknown, unknown> {
	return Object.freeze({
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({ suffix: "configured" }),
		fetch: async () => new Response(null, { status: 204 }),
		instanceId: "review",
		log: { info: vi.fn() },
		serviceKey: "fixture",
		signal,
		state: Object.freeze({ prefix: "state" }),
		storage: { path: (path) => `/tmp/${path}` },
		tasks: { track: async (_label, task) => task },
	});
}

function fixtureService(context: RunningPluginContext<unknown, unknown>): AnyServiceLifecycle {
	return {
		pluginId: "fixture",
		reconcile: async () => ({ kind: "unchanged", stateVersion: 1 }),
		runningContext: (signal) =>
			signal
				? Object.freeze({ ...context, signal: AbortSignal.any([context.signal, signal]) })
				: context,
		seed: async () => undefined,
		serviceKey: "fixture",
		start: async () => undefined,
		stateVersion: 1,
		status: () => "running",
		stop: async () => undefined,
	};
}
