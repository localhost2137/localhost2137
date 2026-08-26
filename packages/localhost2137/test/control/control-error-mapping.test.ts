import { describe, expect, it } from "vitest";
import { LocalhostError } from "../../src/authoring/localhost-error.js";
import { controlErrorEnvelope, mapControlError } from "../../src/control/control-error-mapping.js";
import { TimeAdvanceCommittedError } from "../../src/kernel/durable-time-advancement.js";

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

	it.each([true, false])(
		"exposes reconciliationPending=%s and only marks pending clock work retryable",
		(reconciliationPending) => {
			const committed = new TimeAdvanceCommittedError(
				Object.freeze({
					advanceId: "advance_safe",
					from: "2026-01-01T00:00:00.000Z",
					mode: "pinned",
					to: "2026-01-01T00:00:01.000Z",
				}),
				[new Error("sensitive internal failure")],
				reconciliationPending,
			);

			const mapped = mapControlError(committed, "adapter-correlation");

			expect(mapped.retryable).toBe(reconciliationPending);
			expect(controlErrorEnvelope(mapped)).toEqual({
				error: {
					code: "INSTANCE_MUTATION_COMMITTED",
					correlationId: "adapter-correlation",
					details: {
						advanceId: "advance_safe",
						from: "2026-01-01T00:00:00.000Z",
						mode: "pinned",
						reconciliationPending,
						to: "2026-01-01T00:00:01.000Z",
					},
					message: reconciliationPending
						? "The clock moved, but time reconciliation remains pending."
						: "The clock moved and time reconciliation completed, but a durability check failed.",
				},
			});
		},
	);
});
