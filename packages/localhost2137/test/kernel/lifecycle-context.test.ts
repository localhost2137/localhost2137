import { describe, expect, it, vi } from "vitest";
import {
	createBasePluginContext,
	createRunningPluginContext,
	type LifecycleContextCapabilities,
} from "../../src/kernel/lifecycle-context.js";

describe("phase-specific lifecycle contexts", () => {
	it("keeps running-only capabilities out of create/update/start contexts", () => {
		const capabilities = fixtureCapabilities();
		const context = createBasePluginContext(capabilities);

		expect(context).toMatchObject({ config: { name: "fixture" }, instanceId: "dev" });
		expect("state" in context).toBe(false);
		expect("tasks" in context).toBe(false);
		expect("fetch" in context).toBe(false);
		expect(Object.isFrozen(context)).toBe(true);
	});

	it("composes running state, tasks, and the injected delivery seam", async () => {
		const capabilities = fixtureCapabilities();
		const state = { open: true };
		const context = createRunningPluginContext(capabilities, state);

		expect(context.state).toBe(state);
		expect(context.tasks).toBe(capabilities.tasks);
		await context.fetch("http://example.test");
		expect(capabilities.fetch).toHaveBeenCalledWith("http://example.test", {
			signal: context.signal,
		});
	});
});

function fixtureCapabilities(): LifecycleContextCapabilities<{ name: string }> {
	return {
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({ name: "fixture" }),
		fetch: vi.fn(async () => new Response(null, { status: 204 })),
		instanceId: "dev",
		log: { info: vi.fn() },
		serviceKey: "slack",
		signal: new AbortController().signal,
		storage: { path: (path) => `/data/${path}` },
		tasks: { track: async (_label, task) => task },
	};
}
