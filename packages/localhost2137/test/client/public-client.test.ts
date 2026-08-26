import { describe, expect, it, vi } from "vitest";
import { connectRuntime } from "../../src/client/index.js";

describe("public runtime client", () => {
	it("exposes the narrow introspection-driven client without internal construction seams", async () => {
		const publicClient = await import("../../src/client/index.js");
		expect(Object.keys(publicClient).sort()).toEqual([
			"ControlApiError",
			"ControlProtocolError",
			"ControlTransportError",
			"connectRuntime",
		]);
	});

	it("rejects extra and accessor options before reading them", () => {
		expect(() =>
			Reflect.apply(connectRuntime, undefined, [
				{
					fetch: vi.fn(),
					token: "control-token",
					url: "http://127.0.0.1:2137",
				},
			]),
		).toThrow(/exactly url and token/);

		const options = { token: "control-token" };
		Object.defineProperty(options, "url", {
			enumerable: true,
			get: () => {
				throw new Error("must not be invoked");
			},
		});
		expect(() => Reflect.apply(connectRuntime, undefined, [options])).toThrow(/data properties/);
	});
});
