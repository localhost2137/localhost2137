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
			correlationId: () => "correlation-1",
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});
		const factory = createScenarioSeedFactory(config, runner);
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
			correlationId: () => "correlation-1",
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});

		expect(createScenarioSeedFactory(config, runner)).toBeUndefined();
	});
});

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
