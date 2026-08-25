import { describe, expect, it } from "vitest";
import { type StructuredLogInput, StructuredLogRing } from "../../src/kernel/structured-log.js";

describe("StructuredLogRing", () => {
	it("centrally redacts secrets, omits nested bodies, and owns safe attributes", () => {
		const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 10 });
		const attributes: Record<string, unknown> = {
			authorization: "Bearer private",
			nested: { payload: { private: true }, token: "private", visible: "safe" },
		};
		attributes.circular = attributes;
		ring.append(logInput("sanitized", attributes));
		attributes.nested = "changed";

		expect(ring.snapshot().entries[0]?.attributes).toEqual({
			authorization: "[REDACTED]",
			circular: "[CIRCULAR]",
			nested: { payload: "[OMITTED]", token: "[REDACTED]", visible: "safe" },
		});
	});

	it("evicts by entry count and reports dropped entries", () => {
		const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 2 });
		ring.append(logInput("one"));
		ring.append(logInput("two"));
		ring.append(logInput("three"));

		expect(ring.snapshot()).toMatchObject({
			droppedEntries: 1,
			entries: [{ message: "two" }, { message: "three" }],
		});
		expect(ring.snapshot({ tail: 1 }).entries.map(({ message }) => message)).toEqual(["three"]);
	});

	it("never exceeds the byte budget, including for one oversized event", () => {
		const ring = new StructuredLogRing({ maxBytes: 300, maxEntries: 10 });
		expect(ring.append(logInput("small"))).toBe(true);
		expect(ring.append(logInput("x".repeat(1_000)))).toBe(false);
		expect(ring.snapshot()).toMatchObject({ droppedEntries: 1, entries: [{ message: "small" }] });
	});
});

function logInput(
	message: string,
	attributes?: Readonly<Record<string, unknown>>,
): StructuredLogInput {
	return {
		...(attributes ? { attributes } : {}),
		correlationId: "correlation-1",
		instanceId: "dev",
		kind: "lifecycle",
		message,
		serviceKey: "slack",
		status: "succeeded",
		virtualTime: "2026-08-25T12:00:00.000Z",
		wallTime: "2026-08-25T12:00:00.000Z",
	};
}
