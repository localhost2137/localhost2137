import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type BasePluginContext,
	definePlugin,
	type PluginEnv,
	type RunningPluginContext,
} from "../../src/authoring/index.js";
import { resolveConfig } from "../../src/config/config-resolution.js";
import { createInstanceTemplate } from "../../src/node/resolved-instance-template.js";

describe("createInstanceTemplate", () => {
	it("adapts every resolved lifecycle hook without leaking unvalidated callable types", async () => {
		type Config = { readonly label: string };
		type State = { readonly ready: true };
		const events: unknown[] = [];
		const plugin = definePlugin({
			api: new Hono<PluginEnv<State, Config>>(),
			configSchema: z.object({ label: z.string() }),
			connection: () => ({ env: {}, values: {} }),
			description: "Lifecycle adapter fixture",
			id: "fixture",
			lifecycle: {
				create: (context) => events.push(["create", context.config.label]),
				seed: (context, seed) => events.push(["seed", context.state.ready, seed.label]),
				start: (context): State => {
					events.push(["start", context.instanceId]);
					return { ready: true };
				},
				stop: (context) => events.push(["stop", context.serviceKey]),
				update: (_context, version) => events.push(["update", version.from, version.to]),
			},
			operations: {},
			seedSchema: z.object({ label: z.string() }),
			stateVersion: 2,
		});
		const resolved = resolveConfig(
			{
				services: {
					fixture: plugin({ config: { label: "configured" }, seed: { label: "seeded" } }),
				},
			},
			"/workspace/localhost.config.ts",
		);
		const template = createInstanceTemplate(resolved);
		const service = template.services[0];
		if (!service) throw new Error("Expected resolved fixture service.");
		const base = baseContext(service.config);

		await service.hooks.create(base);
		await service.hooks.update?.(base, { from: 1, to: 2 });
		const state = await service.hooks.start(base);
		const running = runningContext(base, state);
		await service.hooks.seed?.(running, service.configuredSeed);
		await service.hooks.stop?.(running);

		expect(events).toEqual([
			["create", "configured"],
			["update", 1, 2],
			["start", "dev"],
			["seed", true, "seeded"],
			["stop", "fixture"],
		]);
		expect(service).toMatchObject({
			pluginId: "fixture",
			serviceKey: "fixture",
			stateVersion: 2,
		});
		expect(Object.isFrozen(template)).toBe(true);
		expect(Object.isFrozen(template.services)).toBe(true);
	});
});

function baseContext(config: unknown): BasePluginContext<unknown> {
	return Object.freeze({
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config,
		instanceId: "dev",
		log: { info: () => undefined },
		serviceKey: "fixture",
		signal: new AbortController().signal,
		storage: { path: (relativePath: string) => `/tmp/${relativePath}` },
	});
}

function runningContext(
	base: BasePluginContext<unknown>,
	state: unknown,
): RunningPluginContext<unknown, unknown> {
	return Object.freeze({
		...base,
		fetch: async () => new Response(null, { status: 204 }),
		state,
		tasks: { track: async <Value>(_label: string, task: Promise<Value>) => task },
	});
}
