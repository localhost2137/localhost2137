import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RunningPluginContext } from "../../src/authoring/context.js";
import { LocalhostError } from "../../src/authoring/localhost-error.js";
import { defineOperation } from "../../src/authoring/operation.js";
import { type ControlRuntime, createControlApi } from "../../src/control/control-api.js";
import type { ControlServiceCatalog } from "../../src/control/control-service-catalog.js";
import { createRuntimeHttpApplication } from "../../src/http/runtime-http-application.js";
import { OperationExecutor, OperationRunner } from "../../src/kernel/operation-executor.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";

const TOKEN = "test-control-token";
const EMPTY_METADATA = Object.freeze({
	cli: Object.freeze({ kind: "flags" as const, options: Object.freeze([]) }),
	description: "fixture operation",
	input: Object.freeze({ type: "object" as const }),
	output: Object.freeze({ type: "object" as const }),
});

describe("control API policy", () => {
	it("keeps health open while authenticating every other endpoint", async () => {
		const fixture = controlFixture();

		const health = await fixture.app.request("/health", {
			headers: { origin: "https://app.test" },
		});
		const protectedResponse = await fixture.app.request("/instances");

		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ data: { status: "ok", version: "v1" } });
		expect(protectedResponse.status).toBe(401);
		expect(await protectedResponse.json()).toEqual({
			error: {
				code: "AUTHENTICATION_REQUIRED",
				correlationId: "control-2",
				message: "A valid control bearer token is required.",
			},
		});
		expect(protectedResponse.headers.has("access-control-allow-origin")).toBe(false);
	});

	it("rejects browser-origin control traffic without affecting public traffic", async () => {
		const fixture = controlFixture();
		const publicGateway = new Hono();
		publicGateway.all("/*", (context) => context.json({ public: true }));
		const runtime = createRuntimeHttpApplication({ control: fixture.app, publicGateway });

		const control = await runtime.request("/_/v1/instances", {
			headers: { ...authorization(), origin: "https://untrusted.test" },
		});
		const publicResponse = await runtime.request("/dev/fixture/path", {
			headers: { origin: "https://application.test" },
		});

		expect(control.status).toBe(403);
		expect(await control.json()).toMatchObject({
			error: { code: "BROWSER_ORIGIN_REJECTED" },
		});
		expect(publicResponse.status).toBe(200);
		expect(await publicResponse.json()).toEqual({ public: true });
	});

	it("requires JSON mutations and enforces the body limit before parsing", async () => {
		const fixture = controlFixture({ bodyLimitBytes: 32 });

		const wrongType = await fixture.app.request("/instances", {
			body: "id=dev",
			headers: authorization(),
			method: "POST",
		});
		const oversized = await fixture.app.request("/instances", {
			body: JSON.stringify({ id: "a".repeat(64) }),
			headers: jsonHeaders(),
			method: "POST",
		});
		const malformed = await fixture.app.request("/instances", {
			body: "{not json}",
			headers: jsonHeaders(),
			method: "POST",
		});

		expect(wrongType.status).toBe(415);
		expect(await wrongType.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
		expect(fixture.runtime.create).not.toHaveBeenCalled();
	});

	it("returns stable data envelopes for instance and service discovery without config values", async () => {
		const fixture = controlFixture();

		const instances = await fixture.app.request("/instances", { headers: authorization() });
		const services = await fixture.app.request("/instances/dev/services", {
			headers: authorization(),
		});
		const service = await fixture.app.request("/instances/dev/services/fixture", {
			headers: authorization(),
		});

		expect(await instances.json()).toEqual({ data: [instanceSummary()] });
		expect(await services.json()).toEqual({
			data: [
				{
					description: "Fixture emulator",
					name: "fixture",
					operations: ["greet"],
					pluginId: "fixture",
					stateVersion: 1,
				},
			],
		});
		const serviceData = await service.json();
		expect(serviceData).toMatchObject({
			data: {
				name: "fixture",
				operationMetadata: { greet: EMPTY_METADATA },
				status: "running",
			},
		});
		expect(JSON.stringify(serviceData)).not.toContain("configured-secret");
	});

	it("uses the same validated operation result through direct and control HTTP", async () => {
		const operation = defineOperation<"fixture", Record<string, never>, Record<string, never>>()({
			description: "greet",
			input: z.object({ name: z.string(), punctuation: z.string().default("!") }),
			output: z.object({ greeting: z.string() }),
			run: (_context, input) => ({ greeting: `Hello ${input.name}${input.punctuation}` }),
		});
		const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
		let correlation = 0;
		const runner = new OperationRunner({
			time: fixedTime(),
		});
		const executor = new OperationExecutor(
			{
				acquireService: async () => ({
					context: runningContext(),
					generation: {},
					logs,
					release: vi.fn(),
				}),
			},
			{
				resolve: (_serviceKey, operationKey) => (operationKey === "greet" ? operation : undefined),
			},
			runner,
			() => `operation-${++correlation}`,
		);
		const fixture = controlFixture({ operations: executor });

		const direct = await executor.execute({
			instanceId: "dev",
			operationKey: "greet",
			rawInput: { name: "Ada" },
			serviceKey: "fixture",
		});
		const response = await fixture.app.request("/instances/dev/services/fixture/operations/greet", {
			body: JSON.stringify({ name: "Ada" }),
			headers: jsonHeaders(),
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: direct });
		expect(logs.snapshot().entries.map(({ status }) => status)).toEqual([
			"started",
			"succeeded",
			"started",
			"succeeded",
		]);
	});

	it("never exposes plugin causes, stacks, tokens, or unsafe details", async () => {
		const operations = {
			execute: vi.fn(async () => {
				throw new Error("secret token xoxb-never-return-this");
			}),
		};
		const fixture = controlFixture({ operations });

		const response = await fixture.app.request("/instances/dev/services/fixture/operations/greet", {
			body: "{}",
			headers: jsonHeaders(),
			method: "POST",
		});
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(JSON.parse(body)).toMatchObject({
			error: {
				code: "INTERNAL_ERROR",
				message: "The runtime could not complete the request.",
			},
		});
		expect(body).not.toContain("xoxb-never-return-this");
		expect(body).not.toContain("stack");
		expect(body).not.toContain(TOKEN);
	});

	it("redacts expected error messages and details at the control boundary", async () => {
		const operations = {
			execute: vi.fn(async () => {
				throw new LocalhostError(
					"EXPECTED_FAILURE",
					"Expected failure token=xoxb-private-message.",
					{
						details: { nested: { signingSecret: "private-detail", visible: true } },
						status: 409,
					},
				);
			}),
		};
		const fixture = controlFixture({ operations });

		const response = await fixture.app.request("/instances/dev/services/fixture/operations/fail", {
			body: "{}",
			headers: jsonHeaders(),
			method: "POST",
		});
		const body = await response.text();

		expect(response.status).toBe(409);
		expect(JSON.parse(body)).toEqual({
			error: {
				code: "EXPECTED_FAILURE",
				correlationId: "control-1",
				details: { nested: { signingSecret: "[REDACTED]", visible: true } },
				message: "Expected failure [REDACTED]",
			},
		});
		expect(body).not.toContain("xoxb-private-message");
		expect(body).not.toContain("private-detail");
	});

	it("uses the adapter correlation for operation failures and their logs", async () => {
		const bindOperation = defineOperation<"fixture", object, object>();
		const operations = {
			expected: bindOperation({
				description: "expected failure",
				input: z.object({}),
				output: z.null(),
				run: () => {
					throw new LocalhostError("EXPECTED_FAILURE", "Expected failure.", { status: 409 });
				},
			}),
			invalid: bindOperation({
				description: "invalid input",
				input: z.object({ name: z.string() }),
				output: z.null(),
				run: () => null,
			}),
			unknown: bindOperation({
				description: "unknown failure",
				input: z.object({}),
				output: z.null(),
				run: () => {
					throw new Error("private plugin failure");
				},
			}),
		};
		const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
		const directCorrelation = vi.fn(() => "direct-correlation");
		const executor = new OperationExecutor(
			{
				acquireService: async () => ({
					context: runningContext(),
					generation: {},
					logs,
					release: vi.fn(),
				}),
			},
			{ resolve: (_service, operation) => operations[operation as keyof typeof operations] },
			new OperationRunner({ time: fixedTime() }),
			directCorrelation,
		);
		const fixture = controlFixture({ operations: executor });

		const responses: Response[] = [];
		for (const [operation, body] of [
			["invalid", { name: 42 }],
			["expected", {}],
			["unknown", {}],
		] as const) {
			responses.push(
				await fixture.app.request(`/instances/dev/services/fixture/operations/${operation}`, {
					body: JSON.stringify(body),
					headers: jsonHeaders(),
					method: "POST",
				}),
			);
		}
		const envelopes = await Promise.all(responses.map((response) => response.json()));

		expect(envelopes.map(({ error }) => error.correlationId)).toEqual([
			"control-1",
			"control-2",
			"control-3",
		]);
		expect(logs.snapshot().entries.map(({ correlationId }) => correlationId)).toEqual([
			"control-1",
			"control-1",
			"control-2",
			"control-2",
			"control-3",
			"control-3",
		]);
		expect(directCorrelation).not.toHaveBeenCalled();
	});

	it("routes every lifecycle, log, clock, and idle endpoint through the runtime", async () => {
		const fixture = controlFixture();
		const mutation = (path: string, body: unknown, method: "DELETE" | "POST" = "POST") =>
			fixture.app.request(path, {
				body: JSON.stringify(body),
				headers: jsonHeaders(),
				method,
			});

		const create = await mutation("/instances", { id: "review", seed: true });
		const reset = await mutation("/instances/dev/reset", { seed: true });
		const seed = await mutation("/instances/dev/seed", {});
		const idle = await mutation("/instances/dev/idle", { timeoutMs: 1234 });
		const destroy = await mutation("/instances/dev", {}, "DELETE");
		const clock = await fixture.app.request("/instances/dev/clock", {
			headers: authorization(),
		});
		const advance = await mutation("/instances/dev/clock/advance", { duration: "30d" });
		const logs = await fixture.app.request("/instances/dev/logs?tail=10&service=fixture", {
			headers: authorization(),
		});

		expect(create.status).toBe(201);
		expect([reset, seed, idle, destroy, clock, advance, logs].map(({ status }) => status)).toEqual([
			200, 200, 200, 200, 200, 200, 200,
		]);
		expect(fixture.runtime.create).toHaveBeenCalledWith({
			id: "review",
			persistence: "persistent",
			seed: true,
			signal: expect.any(AbortSignal),
			timeoutMs: 30_000,
		});
		expect(fixture.runtime.reset).toHaveBeenCalledWith("dev", {
			seed: true,
			signal: expect.any(AbortSignal),
			timeoutMs: 30_000,
		});
		expect(fixture.runtime.seed).toHaveBeenCalledOnce();
		expect(fixture.runtime.idle).toHaveBeenCalledWith("dev", {
			signal: expect.any(AbortSignal),
			timeoutMs: 1234,
		});
		expect(fixture.runtime.destroy).toHaveBeenCalledOnce();
		expect(fixture.runtime.advanceClock).toHaveBeenCalledWith("dev", "30d", {
			signal: expect.any(AbortSignal),
			timeoutMs: 30_000,
		});
		expect(await clock.json()).toEqual({ data: instanceSummary().clock });
		expect(await logs.json()).toEqual({
			data: { droppedEntries: 0, entries: [] },
		});
	});

	it("returns authenticated unknown endpoints as versioned 404 errors", async () => {
		const fixture = controlFixture();

		const response = await fixture.app.request("/unknown", { headers: authorization() });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "INVALID_REQUEST",
				correlationId: "control-1",
				message: "Control endpoint not found.",
			},
		});
	});
});

function controlFixture(
	options: Readonly<{
		bodyLimitBytes?: number;
		operations?: { execute: (...arguments_: never[]) => Promise<unknown> };
	}> = {},
): Readonly<{ app: ReturnType<typeof createControlApi>; runtime: ControlRuntimeSpies }> {
	const runtime = runtimeSpies();
	let correlation = 0;
	const app = createControlApi({
		...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
		catalog: serviceCatalog(),
		correlationId: () => `control-${++correlation}`,
		operations: options.operations ?? { execute: vi.fn(async () => null) },
		runtime,
		token: TOKEN,
	});
	return Object.freeze({ app, runtime });
}

type ControlRuntimeSpies = ControlRuntime & {
	readonly create: ReturnType<typeof vi.fn<ControlRuntime["create"]>>;
};

function runtimeSpies(): ControlRuntimeSpies {
	return {
		advanceClock: vi.fn(async () => ({
			advanceId: "advance_12345678",
			from: "2026-08-25T12:00:00.000Z",
			mode: "real" as const,
			to: "2026-09-24T12:00:00.000Z",
		})),
		create: vi.fn(async () => instanceSummary()),
		destroy: vi.fn(async () => undefined),
		get: vi.fn(async () => instanceSummary()),
		idle: vi.fn(async () => undefined),
		list: vi.fn(async () => [instanceSummary()]),
		logs: vi.fn(() => ({ droppedEntries: 0, entries: [] })),
		reset: vi.fn(async () => instanceSummary()),
		seed: vi.fn(async () => undefined),
	};
}

function serviceCatalog(): ControlServiceCatalog {
	const description = Object.freeze({
		description: "Fixture emulator",
		name: "fixture",
		operationMetadata: Object.freeze({ greet: EMPTY_METADATA }),
		operations: Object.freeze(["greet"]),
		pluginId: "fixture",
		stateVersion: 1,
	});
	return {
		describe: (serviceKey) => (serviceKey === "fixture" ? description : undefined),
		list: () => {
			const { operationMetadata: _operationMetadata, ...summary } = description;
			return [summary];
		},
	};
}

function instanceSummary() {
	return Object.freeze({
		clock: Object.freeze({ mode: "real" as const, now: "2026-08-25T12:00:00.000Z" }),
		id: "dev",
		persistence: "persistent" as const,
		seedStatus: "unseeded" as const,
		services: Object.freeze([Object.freeze({ key: "fixture", status: "running" as const })]),
		status: "running" as const,
	});
}

function runningContext(): RunningPluginContext<unknown, unknown> {
	return Object.freeze({
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({}),
		fetch: async () => new Response(null, { status: 204 }),
		instanceId: "dev",
		log: { info: vi.fn() },
		serviceKey: "fixture",
		signal: new AbortController().signal,
		state: Object.freeze({}),
		storage: { path: (path) => `/tmp/${path}` },
		tasks: { track: async (_label, task) => task },
	});
}

function fixedTime() {
	return {
		nowMilliseconds: () => 1,
		nowTimestamp: () => "2026-08-25T12:00:00.000Z",
	};
}

function authorization(): Readonly<Record<string, string>> {
	return { authorization: `Bearer ${TOKEN}` };
}

function jsonHeaders(): Readonly<Record<string, string>> {
	return { ...authorization(), "content-type": "application/json" };
}
