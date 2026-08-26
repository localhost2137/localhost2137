import { describe, expect, it, vi } from "vitest";
import {
	LifecycleHookError,
	ServiceIdentityConflictError,
	ServiceLifecycle,
	type ServiceLifecycleHooks,
	ServiceSeedContractError,
	ServiceStateDowngradeError,
	ServiceUpdateRequiredError,
} from "../../src/kernel/service-lifecycle.js";
import { fixtureCapabilities, fixtureHookRunner } from "./support/lifecycle-fixtures.js";

describe("ServiceLifecycle", () => {
	it("returns to absent when create fails", async () => {
		const failure = new Error("schema creation failed");
		const service = fixtureService({ create: () => Promise.reject(failure) });

		await expect(service.reconcile()).rejects.toMatchObject({ cause: failure, hook: "create" });
		expect(service.status()).toBe("absent");
	});

	it("creates new storage once, then starts and stops its returned state once", async () => {
		const events: string[] = [];
		const state = { id: "state" };
		const service = fixtureService({
			create: () => events.push("create"),
			start: () => {
				events.push("start");
				return state;
			},
			onStarted: (context) => {
				events.push(`onStarted:${context.state === state}`);
			},
			stop: (context) => {
				events.push(`stop:${context.state === state}`);
			},
		});

		await expect(service.reconcile()).resolves.toEqual({ kind: "created", stateVersion: 2 });
		await service.start();
		await service.onStarted();
		expect(service.runningContext().state).toBe(state);
		await service.stop();
		expect(events).toEqual(["create", "start", "onStarted:true", "stop:true"]);
		await expect(service.stop()).rejects.toMatchObject({ owner: "service", status: "stopped" });
	});

	it("updates a stored older version while stopped and reports the exact range", async () => {
		const update = vi.fn();
		const service = fixtureService({ update });

		await expect(service.reconcile({ pluginId: "fixture", stateVersion: 1 })).resolves.toEqual({
			from: 1,
			kind: "updated",
			stateVersion: 2,
		});
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: "service-a" }), {
			from: 1,
			to: 2,
		});
		expect(service.status()).toBe("stopped");
	});

	it("leaves the stored state stopped and unadvanced when update fails", async () => {
		const failure = new Error("migration failed");
		const service = fixtureService({ update: () => Promise.reject(failure) });

		await expect(service.reconcile({ pluginId: "fixture", stateVersion: 1 })).rejects.toMatchObject(
			{ cause: failure, hook: "update", serviceKey: "service-a" },
		);
		expect(service.status()).toBe("stopped");
	});

	it("rejects plugin replacement, downgrade, and a missing update hook before start", async () => {
		await expect(
			fixtureService().reconcile({ pluginId: "other", stateVersion: 2 }),
		).rejects.toBeInstanceOf(ServiceIdentityConflictError);
		await expect(
			fixtureService().reconcile({ pluginId: "fixture", stateVersion: 3 }),
		).rejects.toBeInstanceOf(ServiceStateDowngradeError);
		await expect(
			fixtureService().reconcile({ pluginId: "fixture", stateVersion: 1 }),
		).rejects.toBeInstanceOf(ServiceUpdateRequiredError);
	});

	it("wraps hook failures with phase and correlation diagnostics", async () => {
		const failure = new Error("open failed");
		const service = fixtureService({ start: () => Promise.reject(failure) });
		await service.reconcile();

		const start = service.start();
		await expect(start).rejects.toBeInstanceOf(LifecycleHookError);
		await expect(start).rejects.toMatchObject({
			cause: failure,
			correlationId: "correlation-1",
			hook: "start",
			instanceId: "dev",
			serviceKey: "service-a",
		});
	});

	it("wraps post-start failures with their exact lifecycle phase", async () => {
		const failure = new Error("recovery failed");
		const service = fixtureService({ onStarted: () => Promise.reject(failure) });
		await service.reconcile();
		await service.start();

		await expect(service.onStarted()).rejects.toMatchObject({
			cause: failure,
			hook: "onStarted",
			serviceKey: "service-a",
		});
	});

	it("fails explicitly if untyped input violates the seed hook contract", async () => {
		const service = fixtureService({}, { configured: true });
		await service.reconcile();
		await service.start();
		await expect(service.seed()).rejects.toBeInstanceOf(ServiceSeedContractError);
	});
});

function fixtureService(
	overrides: Partial<ServiceLifecycleHooks<unknown, unknown, unknown>> = {},
	configuredSeed?: unknown,
): ServiceLifecycle<unknown, unknown, unknown> {
	return new ServiceLifecycle({
		capabilities: fixtureCapabilities("service-a"),
		...(configuredSeed === undefined ? {} : { configuredSeed }),
		correlationId: () => "correlation-1",
		hookRunner: fixtureHookRunner(),
		hooks: {
			create: () => undefined,
			start: () => ({ ready: true }),
			...overrides,
		},
		pluginId: "fixture",
		stateVersion: 2,
	});
}
