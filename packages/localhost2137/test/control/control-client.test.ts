import { describe, expect, it, vi } from "vitest";
import {
	ControlApiError,
	ControlProtocolError,
	ControlTransportError,
	connectRuntime,
} from "../../src/control/control-client.js";

const URL = "http://127.0.0.1:2137";
const TOKEN = "control-token-value";

describe("control client", () => {
	it("authenticates requests, encodes path segments, and deeply owns response data", async () => {
		const transport = vi.fn(async () => jsonResponse({ data: { nested: [{ value: true }] } }));
		const client = connectRuntime({ fetch: transport, token: TOKEN, url: `${URL}/` });

		const result = await client.executeOperation("dev", "fixture/key", "create User", {
			name: "Ada",
		});

		expect(result).toEqual({ nested: [{ value: true }] });
		expect(Object.isFrozen(result)).toBe(true);
		if (typeof result !== "object" || result === null || Array.isArray(result)) {
			throw new Error("Expected an object response.");
		}
		expect(Object.isFrozen(result.nested)).toBe(true);
		const [requestUrl, init] = transport.mock.calls[0] ?? [];
		expect(requestUrl).toBe(
			`${URL}/_/v1/instances/dev/services/fixture%2Fkey/operations/create%20User`,
		);
		expect(init).toMatchObject({
			body: '{"name":"Ada"}',
			headers: {
				accept: "application/json",
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			method: "POST",
			redirect: "error",
		});
	});

	it("sends clock advancement through the versioned mutation endpoint", async () => {
		const transport = vi.fn(async () => jsonResponse({ data: { advanceId: "advance_1" } }));
		const client = connectRuntime({ fetch: transport, token: TOKEN, url: URL });

		await client.clockAdvance("review", "30d");

		expect(transport).toHaveBeenCalledWith(
			`${URL}/_/v1/instances/review/clock/advance`,
			expect.objectContaining({ body: '{"duration":"30d"}', method: "POST" }),
		);
		await expect(Reflect.apply(client.clockAdvance, client, ["review", 30])).rejects.toThrow(
			/string/,
		);
	});

	it("preserves safe remote error identity, correlation, status, and immutable details", async () => {
		const response = new Response(
			'{"error":{"code":"INSTANCE_NOT_FOUND","correlationId":"correlation-2137","details":{"__proto__":{"safe":true},"instances":["dev"]},"message":"Instance not found."}}',
			{ headers: { "content-type": "application/json" }, status: 404 },
		);
		const client = connectRuntime({ fetch: async () => response, token: TOKEN, url: URL });

		const failure = await client.getInstance("missing").catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(ControlApiError);
		expect(failure).toMatchObject({
			code: "INSTANCE_NOT_FOUND",
			correlationId: "correlation-2137",
			details: { instances: ["dev"] },
			kind: "api",
			message: "Instance not found.",
			status: 404,
		});
		const details = (failure as ControlApiError).details;
		expect(Object.hasOwn(details ?? {}, "__proto__")).toBe(true);
		expect(Object.isFrozen(details)).toBe(true);
		expect(Object.getPrototypeOf(details)).toBeNull();
	});

	it.each([
		["an unknown envelope field", { data: null, metadata: {} }, 200],
		["an error envelope on success", errorEnvelope(), 200],
		["a data envelope on failure", { data: null }, 500],
		["an unknown error field", { error: { ...errorEnvelope().error, retryable: false } }, 400],
	])("rejects %s", async (_label, body, status) => {
		const client = connectRuntime({
			fetch: async () => jsonResponse(body, status),
			token: TOKEN,
			url: URL,
		});

		await expect(client.health()).rejects.toBeInstanceOf(ControlProtocolError);
	});

	it("rejects non-JSON and oversized response bodies without exposing their contents", async () => {
		const nonJson = connectRuntime({
			fetch: async () => new Response("private body", { status: 502 }),
			token: TOKEN,
			url: URL,
		});
		const oversized = connectRuntime({
			fetch: async () =>
				new Response('{"data":"private body"}', {
					headers: { "content-length": "23", "content-type": "application/json" },
				}),
			responseBodyLimitBytes: 16,
			token: TOKEN,
			url: URL,
		});

		const nonJsonFailure = await nonJson.health().catch((cause: unknown) => cause);
		const oversizedFailure = await oversized.health().catch((cause: unknown) => cause);
		expect(nonJsonFailure).toBeInstanceOf(ControlProtocolError);
		expect(String(nonJsonFailure)).not.toContain("private body");
		expect(oversizedFailure).toBeInstanceOf(ControlProtocolError);
		expect(String(oversizedFailure)).not.toContain("private body");
	});

	it("distinguishes transport cancellation from other transport failures", async () => {
		const transportFailure = new Error("socket closed");
		const unavailable = connectRuntime({
			fetch: async () => {
				throw transportFailure;
			},
			token: TOKEN,
			url: URL,
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const cancelled = connectRuntime({
			fetch: async () => {
				throw controller.signal.reason;
			},
			token: TOKEN,
			url: URL,
		});

		const unavailableFailure = await unavailable.health().catch((cause: unknown) => cause);
		const cancelledFailure = await cancelled
			.health({ signal: controller.signal })
			.catch((cause: unknown) => cause);
		expect(unavailableFailure).toMatchObject({ aborted: false, kind: "transport" });
		expect((unavailableFailure as Error).cause).toBe(transportFailure);
		expect(unavailableFailure).toBeInstanceOf(ControlTransportError);
		expect(cancelledFailure).toMatchObject({ aborted: true, kind: "transport" });
	});

	it("rejects unsafe connection options before invoking the transport", () => {
		expect(() => connectRuntime({ token: "bad token", url: URL })).toThrow(/without whitespace/);
		expect(() => connectRuntime({ token: TOKEN, url: "https://127.0.0.1:2137" })).toThrow(
			/plain HTTP/,
		);
		expect(() => connectRuntime({ token: TOKEN, url: "http://example.test:2137" })).toThrow(
			/loopback/,
		);
	});
});

function errorEnvelope() {
	return {
		error: {
			code: "INVALID_REQUEST",
			correlationId: "correlation-1",
			message: "Invalid request.",
		},
	};
}

function jsonResponse(value: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}
