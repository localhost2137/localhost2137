import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PluginEnv, RunningPluginContext } from "../../src/authoring/context.js";
import type { RuntimePluginApi } from "../../src/http/plugin-api-registry.js";
import { createPublicGateway } from "../../src/http/public-gateway.js";
import { InstanceNotFoundError } from "../../src/kernel/active-instance-registry.js";
import { InvalidIdentifierError } from "../../src/kernel/identifiers.js";
import type { RunningServiceLease } from "../../src/kernel/instance-manager.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";

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

	it("keeps runtime routing failures distinct from control envelopes", async () => {
		const api = new Hono<PluginEnv<FixtureState, { name: string }>>();
		const fixture = gatewayFixture(api);

		const missingService = await fixture.app.request("/dev/missing/path");
		const invalidInstance = await fixture.app.request("/INVALID/fixture/path");

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
