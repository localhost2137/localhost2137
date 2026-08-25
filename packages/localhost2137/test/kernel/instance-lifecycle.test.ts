import { describe, expect, it } from "vitest";
import {
	InstanceLifecycle,
	InstanceSeedError,
	InstanceStartError,
	InstanceStopError,
	SeedNotAllowedError,
} from "../../src/kernel/instance-lifecycle.js";
import type { InstanceSeedState } from "../../src/kernel/manifests.js";
import {
	ServiceLifecycle,
	type ServiceLifecycleHooks,
} from "../../src/kernel/service-lifecycle.js";
import { fixtureCapabilities } from "./support/lifecycle-fixtures.js";

describe("InstanceLifecycle", () => {
	it("starts in config order, stops prior services after failure, and starts no later service", async () => {
		const events: string[] = [];
		const services = [
			await stoppedService("first", {
				start: () => events.push("start:first"),
				stop: () => events.push("stop:first"),
			}),
			await stoppedService("second", {
				start: () => {
					events.push("start:second");
					throw new Error("cannot start");
				},
			}),
			await stoppedService("third", { start: () => events.push("start:third") }),
		];
		const lifecycle = instance(services);

		await expect(lifecycle.start()).rejects.toBeInstanceOf(InstanceStartError);
		expect(events).toEqual(["start:first", "start:second", "stop:first"]);
		expect(lifecycle.status()).toBe("stopped");
	});

	it("reports cleanup failure after partial start without retrying stop", async () => {
		const stopFailure = new Error("close failed");
		const services = [
			await stoppedService("first", { stop: () => Promise.reject(stopFailure) }),
			await stoppedService("second", { start: () => Promise.reject(new Error("start failed")) }),
		];
		const lifecycle = instance(services);
		const start = lifecycle.start();

		await expect(start).rejects.toMatchObject({ cleanupFailures: [{ cause: stopFailure }] });
		expect(lifecycle.status()).toBe("failed");
		expect(services[0]?.status()).toBe("stop_failed");
	});

	it("attempts every stop in reverse order and aggregates failures", async () => {
		const events: string[] = [];
		const services = [
			await stoppedService("first", {
				stop: () => {
					events.push("stop:first");
					throw new Error("first failed");
				},
			}),
			await stoppedService("second", {
				stop: () => {
					events.push("stop:second");
					throw new Error("second failed");
				},
			}),
		];
		const lifecycle = instance(services);
		await lifecycle.start();

		const stop = lifecycle.stopAll();
		await expect(stop).rejects.toBeInstanceOf(InstanceStopError);
		await expect(stop).rejects.toMatchObject({
			failures: [{ serviceKey: "second" }, { serviceKey: "first" }],
		});
		expect(events).toEqual(["stop:second", "stop:first"]);
	});

	it("seeds services sequentially, runs scenario last, and persists exactly once", async () => {
		const events: string[] = [];
		const states: InstanceSeedState[] = [];
		const services = [
			await stoppedService("first", { seed: () => events.push("seed:first") }, { value: 1 }),
			await stoppedService("second", { seed: () => events.push("seed:second") }, { value: 2 }),
		];
		const lifecycle = instance(services, {
			scenarioSeed: { run: async () => void events.push("seed:scenario") },
			seedStateStore: { write: async (state) => void states.push(state) },
		});
		await lifecycle.start();
		await lifecycle.seed();

		expect(events).toEqual(["seed:first", "seed:second", "seed:scenario"]);
		expect(states.map(({ status }) => status)).toEqual(["seeding", "seeded"]);
		await expect(lifecycle.seed()).rejects.toBeInstanceOf(SeedNotAllowedError);
		expect(events).toHaveLength(3);
	});

	it("persists seed failure diagnostics, skips scenario, and requires reset", async () => {
		const events: string[] = [];
		const states: InstanceSeedState[] = [];
		const services = [
			await stoppedService("first", { seed: () => events.push("seed:first") }, {}),
			await stoppedService(
				"second",
				{
					seed: () => {
						events.push("seed:second");
						throw new Error("bad seed");
					},
				},
				{},
			),
		];
		const lifecycle = instance(services, {
			scenarioSeed: { run: async () => void events.push("seed:scenario") },
			seedStateStore: { write: async (state) => void states.push(state) },
		});
		await lifecycle.start();

		await expect(lifecycle.seed()).rejects.toBeInstanceOf(InstanceSeedError);
		expect(events).toEqual(["seed:first", "seed:second"]);
		expect(states.at(-1)).toMatchObject({
			failure: {
				correlationId: "correlation-second",
				message: expect.stringContaining("bad seed"),
			},
			status: "seed_failed",
		});
		expect(lifecycle.seedStatus()).toBe("seed_failed");
		await expect(lifecycle.seed()).rejects.toBeInstanceOf(SeedNotAllowedError);
	});

	it("keeps the in-memory seed failure terminal when failure persistence also fails", async () => {
		const service = await stoppedService("only", { seed: () => undefined }, {});
		let write = 0;
		const lifecycle = instance([service], {
			seedStateStore: {
				write: async () => {
					write += 1;
					if (write >= 2) throw new Error(`manifest write ${write} failed`);
				},
			},
		});
		await lifecycle.start();

		await expect(lifecycle.seed()).rejects.toMatchObject({ errors: expect.any(Array) });
		expect(lifecycle.seedStatus()).toBe("seed_failed");
		await expect(lifecycle.seed()).rejects.toBeInstanceOf(SeedNotAllowedError);
	});
});

function instance(
	services: readonly ServiceLifecycle<unknown, unknown, unknown>[],
	overrides: Partial<ConstructorParameters<typeof InstanceLifecycle>[0]> = {},
): InstanceLifecycle {
	return new InstanceLifecycle({
		now: () => "2026-08-25T12:00:00.000Z",
		seedState: { attempt: 0, status: "unseeded" },
		seedStateStore: { write: async () => undefined },
		services,
		signal: new AbortController().signal,
		...overrides,
	});
}

async function stoppedService(
	serviceKey: string,
	overrides: Partial<ServiceLifecycleHooks<unknown, unknown, unknown>>,
	configuredSeed?: unknown,
): Promise<ServiceLifecycle<unknown, unknown, unknown>> {
	const service = new ServiceLifecycle({
		capabilities: fixtureCapabilities(serviceKey),
		...(configuredSeed === undefined ? {} : { configuredSeed }),
		correlationId: () => `correlation-${serviceKey}`,
		hooks: { create: () => undefined, start: () => ({ serviceKey }), ...overrides },
		pluginId: "fixture",
		stateVersion: 1,
	});
	await service.reconcile();
	return service;
}
