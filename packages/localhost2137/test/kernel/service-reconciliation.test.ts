import { describe, expect, it } from "vitest";
import {
	ServiceLifecycle,
	type ServiceLifecycleHooks,
} from "../../src/kernel/service-lifecycle.js";
import { reconcileServices } from "../../src/kernel/service-reconciliation.js";
import { fixtureCapabilities, fixtureHookRunner } from "./support/lifecycle-fixtures.js";

describe("service reconciliation", () => {
	it("runs in declaration order and records versions only after successful hooks", async () => {
		const events: string[] = [];
		const services = [
			service("first", { create: () => events.push("create:first") }),
			service("second", {
				update: () => {
					events.push("update:second");
					throw new Error("migration failed");
				},
			}),
			service("third", { create: () => events.push("create:third") }),
		];
		const writes: string[] = [];

		await expect(
			reconcileServices(services, {
				read: async (serviceKey) =>
					serviceKey === "second" ? { pluginId: "fixture", stateVersion: 1 } : undefined,
				write: async ({ serviceKey }) => {
					writes.push(serviceKey);
				},
			}),
		).rejects.toThrow("Lifecycle update failed");
		expect(events).toEqual(["create:first", "update:second"]);
		expect(writes).toEqual(["first"]);
	});

	it("does not rewrite an unchanged service manifest", async () => {
		const services = [service("first")];
		const writes: string[] = [];
		await reconcileServices(services, {
			read: async () => ({ pluginId: "fixture", stateVersion: 2 }),
			write: async ({ serviceKey }) => {
				writes.push(serviceKey);
			},
		});
		expect(writes).toEqual([]);
	});
});

function service(
	serviceKey: string,
	overrides: Partial<ServiceLifecycleHooks<unknown, unknown, unknown>> = {},
): ServiceLifecycle<unknown, unknown, unknown> {
	return new ServiceLifecycle({
		capabilities: fixtureCapabilities(serviceKey),
		correlationId: () => `correlation-${serviceKey}`,
		hookRunner: fixtureHookRunner(),
		hooks: { create: () => undefined, start: () => undefined, ...overrides },
		pluginId: "fixture",
		stateVersion: 2,
	});
}
