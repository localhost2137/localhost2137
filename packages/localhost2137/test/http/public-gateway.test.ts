import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PluginEnv, RunningPluginContext } from "../../src/authoring/context.js";
import type { RuntimePluginApi } from "../../src/http/plugin-api-registry.js";
import { createPublicGateway } from "../../src/http/public-gateway.js";
import { InstanceNotFoundError } from "../../src/kernel/active-instance-registry.js";
import { InvalidIdentifierError } from "../../src/kernel/identifiers.js";
import { InstanceLeaseCoordinator } from "../../src/kernel/instance-leases.js";
import type { RunningServiceLease } from "../../src/kernel/instance-manager.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";
import type { TaskScheduler } from "../../src/kernel/task-tracker.js";

interface FixtureState {
	readonly instance: string;
}

describe("public Hono gateway", () => {
	it("preserves request semantics and keeps concurrent instance contexts isolated", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		const entered: string[] = [];
		const releaseHandlers: Array<() => void> = [];
		api.post("/echo", async (context) => {
			const runtime = context.get("lh");
			entered.push(runtime.state.instance);
			await new Promise<void>((resolve) => releaseHandlers.push(resolve));
			return context.json({
				body: await context.req.json(),
				header: context.req.header("x-fixture"),
				instance: runtime.state.instance,
				query: context.req.query("value"),
			});
		});
		const fixture = gatewayFixture(api);

		const dev = fixture.app.request("/dev/fixture/echo?value=one", {
			body: JSON.stringify({ request: "dev" }),
			headers: { "content-type": "application/json", "x-fixture": "dev-header" },
			method: "POST",
		});
		const review = fixture.app.request("/review/fixture/echo?value=two", {
			body: JSON.stringify({ request: "review" }),
			headers: { "content-type": "application/json", "x-fixture": "review-header" },
			method: "POST",
		});
		await vi.waitFor(() => expect(entered).toHaveLength(2));
		for (const release of releaseHandlers) release();

		await expect((await dev).json()).resolves.toEqual({
			body: { request: "dev" },
			header: "dev-header",
			instance: "dev",
			query: "one",
		});
		await expect((await review).json()).resolves.toEqual({
			body: { request: "review" },
			header: "review-header",
			instance: "review",
			query: "two",
		});
		expect(fixture.releases).toEqual(["dev", "review"]);
		expect(fixture.logs.dev.snapshot().entries.map(({ status }) => status)).toEqual([
			"started",
			"succeeded",
		]);
	});

	it("does not wrap plugin-owned response bodies or status codes", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/failure", (context) =>
			context.json({ error: "invalid_auth", ok: false }, { status: 401 }),
		);
		const fixture = gatewayFixture(api);

		const response = await fixture.app.request("/dev/fixture/failure");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "invalid_auth", ok: false });
		expect(fixture.releases).toEqual(["dev"]);
	});

	it("holds the generation lease until a streaming response is consumed", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/stream", (context) =>
			context.body(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("streamed"));
						controller.close();
					},
				}),
			),
		);
		const fixture = gatewayFixture(api);

		const response = await fixture.app.request("/dev/fixture/stream");
		expect(fixture.releases).toEqual([]);

		expect(await response.text()).toBe("streamed");
		expect(fixture.releases).toEqual(["dev"]);
	});

	it("releases the generation lease when the plugin response stream fails", async () => {
		const failure = new Error("plugin stream failed");
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/stream", (context) =>
			context.body(
				new ReadableStream({
					start(controller) {
						controller.error(failure);
					},
				}),
			),
		);
		const fixture = gatewayFixture(api);

		const response = await fixture.app.request("/dev/fixture/stream");
		await expect(response.text()).rejects.toBe(failure);

		expect(fixture.releases).toEqual(["dev"]);
	});

	it("keeps runtime routing failures distinct from control envelopes", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		const fixture = gatewayFixture(api);

		const missingService = await fixture.app.request("/dev/missing/path");
		const invalidInstance = await fixture.app.request("/INVALID/fixture/path");
		const missingInstance = await fixture.app.request("/missing/fixture/path");

		expect(missingService.status).toBe(404);
		expect(await missingService.json()).toEqual({
			error: "service_not_found",
			message: "Emulated service not found.",
		});
		expect(invalidInstance.status).toBe(400);
		expect(await invalidInstance.json()).toEqual({
			error: "invalid_route",
			message: "Invalid instance or service path.",
		});
		expect(missingInstance.status).toBe(404);
		expect(await missingInstance.json()).toMatchObject({ error: "route_not_found" });
	});

	it("rejects ambiguous encoded separators and keeps normalized traversal inside the plugin", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/*", (context) => context.json({ path: context.req.path }));
		const fixture = gatewayFixture(api);

		const encodedSeparator = await fixture.app.request("/dev/fixture/a%252Fb");
		const encodedTraversal = await fixture.app.request("/dev/fixture/%252e%252e/admin");
		const normalizedTraversal = await fixture.app.request("/dev/fixture/a/../inside");

		expect([encodedSeparator.status, encodedTraversal.status]).toEqual([400, 400]);
		expect(await encodedSeparator.json()).toMatchObject({ error: "invalid_route" });
		expect(await encodedTraversal.json()).toMatchObject({ error: "invalid_route" });
		expect(await normalizedTraversal.json()).toEqual({ path: "/inside" });
	});

	it("rejects malformed and deeply nested route ambiguity without a fixed decode depth", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/*", (context) => context.json({ path: context.req.path }));
		const fixture = gatewayFixture(api);
		const ambiguousPaths = [
			nestedEncoding("%2f", 12),
			nestedEncoding("%5c", 9),
			nestedEncoding("%2e%2e", 7),
			"%E0%A4%A",
		];

		for (const path of ambiguousPaths) {
			const response = await fixture.app.request(`/dev/fixture/${path}/admin`);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({ error: "invalid_route" });
		}
	});

	it("releases exactly once when plugin dispatch fails before producing a response", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		Object.defineProperty(api, "routes", {
			configurable: true,
			get: () => {
				throw new Error("broken plugin route registry");
			},
		});
		const fixture = gatewayFixture(api);

		const response = await fixture.app.request("/dev/fixture/path");

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "plugin_request_failed" });
		expect(fixture.releases).toEqual(["dev"]);
	});

	it("lets an exclusive reset proceed only after an open response is cancelled", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/stream", (context) => context.body(new ReadableStream({ start: () => undefined })));
		const scheduler: TaskScheduler = {
			schedule: (delayMs, callback) => {
				const timer = setTimeout(callback, delayMs);
				return { cancel: () => clearTimeout(timer) };
			},
		};
		const leases = new InstanceLeaseCoordinator({ idle: async () => undefined }, scheduler, {
			nowMilliseconds: () => performance.now(),
		});
		const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
		const app = createPublicGateway({
			apis: { resolve: () => api },
			correlationId: () => "stream-correlation",
			monotonicClock: { nowMilliseconds: () => performance.now() },
			runtime: {
				acquireService: async (_instance, service, signal) => {
					const lease = await leases.acquireShared(signal);
					return {
						context: runningContext("dev", service, signal),
						generation: {},
						logs,
						release: lease.release,
					};
				},
			},
			time: {
				nowMilliseconds: () => performance.now(),
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});
		const response = await app.request("/dev/fixture/stream");
		let resetAcquired = false;
		const reset = leases.acquireExclusive({ timeoutMs: 1_000 }).then((lease) => {
			resetAcquired = true;
			return lease;
		});
		await Promise.resolve();
		expect(resetAcquired).toBe(false);

		await response.body?.cancel("reset race completed");
		const resetLease = await reset;
		expect(resetAcquired).toBe(true);
		resetLease.release();
	});

	it("treats request logging as best effort without leaking a lease", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		api.get("/ok", (context) => context.body(null, 204));
		const release = vi.fn();
		const app = createPublicGateway({
			apis: { resolve: () => api },
			correlationId: () => "log-correlation",
			monotonicClock: { nowMilliseconds: () => 1 },
			runtime: {
				acquireService: async (_instance, service, signal) => ({
					context: runningContext("dev", service, signal),
					generation: {},
					logs: {
						append: () => {
							throw new Error("log sink failed");
						},
					} as unknown as StructuredLogRing,
					release,
				}),
			},
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		});

		const response = await app.request("/dev/fixture/ok");

		expect(response.status).toBe(204);
		expect(release).toHaveBeenCalledOnce();
	});
});

function gatewayFixture(api: RuntimePluginApi): Readonly<{
	app: Hono;
	logs: Readonly<{ dev: StructuredLogRing; review: StructuredLogRing }>;
	releases: string[];
}> {
	const releases: string[] = [];
	const generations = { dev: {}, review: {} } as const;
	const logs = {
		dev: new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 }),
		review: new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 }),
	};
	let correlation = 0;
	let monotonic = 0;
	const app = createPublicGateway({
		apis: { resolve: (serviceKey) => (serviceKey === "fixture" ? api : undefined) },
		correlationId: () => `correlation-${++correlation}`,
		monotonicClock: { nowMilliseconds: () => ++monotonic },
		runtime: {
			acquireService: async (instanceId, serviceKey, signal) => {
				if (!/^[a-z][a-z0-9-]*$/.test(instanceId)) {
					throw new InvalidIdentifierError("instance", instanceId, "invalid test value");
				}
				if (instanceId !== "dev" && instanceId !== "review") {
					throw new InstanceNotFoundError(instanceId);
				}
				const id = instanceId as "dev" | "review";
				return Object.freeze({
					context: runningContext(id, serviceKey, signal),
					generation: generations[id],
					logs: logs[id],
					release: () => releases.push(id),
				}) satisfies RunningServiceLease;
			},
		},
		time: {
			nowMilliseconds: () => 1,
			nowTimestamp: () => "2026-08-25T12:00:00.000Z",
		},
	});
	return Object.freeze({ app, logs: Object.freeze(logs), releases });
}

function runningContext(
	instanceId: "dev" | "review",
	serviceKey: string,
	signal?: AbortSignal,
): RunningPluginContext<unknown, unknown> {
	return Object.freeze({
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({ name: instanceId }),
		fetch: async () => new Response(null, { status: 204 }),
		instanceId,
		log: { info: vi.fn() },
		serviceKey,
		signal: signal ?? new AbortController().signal,
		state: Object.freeze({ instance: instanceId }),
		storage: { path: (path) => `/tmp/${instanceId}/${path}` },
		tasks: { track: async (_label, task) => task },
	});
}

function nestedEncoding(encodedValue: string, additionalDepth: number): string {
	let result = encodedValue;
	for (let depth = 0; depth < additionalDepth; depth += 1) result = encodeURIComponent(result);
	return result;
}
