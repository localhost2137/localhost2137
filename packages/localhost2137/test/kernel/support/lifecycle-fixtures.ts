import { vi } from "vitest";
import type { LifecycleContextCapabilities } from "../../../src/kernel/lifecycle-context.js";

export function fixtureCapabilities(serviceKey: string): LifecycleContextCapabilities<unknown> {
	return {
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({ serviceKey }),
		fetch: vi.fn(async () => new Response(null, { status: 204 })),
		instanceId: "dev",
		log: { info: vi.fn() },
		serviceKey,
		signal: new AbortController().signal,
		storage: { path: (path) => `/data/${serviceKey}/${path}` },
		tasks: { track: async (_label, task) => task },
	};
}
