import { describe, expect, it } from "vitest";
import { LocalhostError } from "../../src/authoring/localhost-error.js";
import { controlErrorEnvelope, mapControlError } from "../../src/control/control-error-mapping.js";

describe("control error mapping trust boundary", () => {
	it("fails closed for a forged LocalhostError instance", () => {
		const forged = Object.create(LocalhostError.prototype);
		Object.defineProperties(forged, {
			code: { enumerable: true, value: "not-stable" },
			message: {
				enumerable: false,
				get: () => {
					throw new Error("token=xoxb-forged-getter");
				},
			},
			retryable: { enumerable: true, value: "yes" },
			status: { enumerable: true, value: 200 },
		});

		const envelope = controlErrorEnvelope(mapControlError(forged, "adapter-correlation"));

		expect(envelope).toEqual({
			error: {
				code: "INTERNAL_ERROR",
				correlationId: "adapter-correlation",
				message: "The runtime could not complete the request.",
			},
		});
		expect(JSON.stringify(envelope)).not.toContain("xoxb-forged-getter");
	});
});
