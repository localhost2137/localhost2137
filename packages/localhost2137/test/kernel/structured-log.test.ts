import { describe, expect, it } from "vitest";
import { ReadonlyInstanceClock } from "../../src/kernel/instance-clock.js";
import { StructuredPluginLogger } from "../../src/kernel/plugin-log-adapter.js";
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

	it("preserves prototype-shaped keys in null-prototype records and densifies arrays", () => {
		const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 10 });
		const attributes: Record<string, unknown> = Object.create(null);
		Object.defineProperty(attributes, "__proto__", {
			enumerable: true,
			value: { constructor: "visible" },
		});
		const sparse: unknown[] = [];
		sparse[2] = "last";
		attributes.values = sparse;

		ring.append(logInput("prototype-safe", attributes));

		const owned = ring.snapshot().entries[0]?.attributes;
		expect(Object.getPrototypeOf(owned)).toBeNull();
		expect(Object.hasOwn(owned ?? {}, "__proto__")).toBe(true);
		expect(Reflect.get(owned ?? {}, "__proto__")).toEqual({ constructor: "visible" });
		expect(owned?.values).toEqual([
			"[UNSERIALIZABLE:undefined]",
			"[UNSERIALIZABLE:undefined]",
			"last",
		]);
		expect(Object.isFrozen(owned?.values)).toBe(true);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
		"rejects invalid duration %s without retaining an entry",
		(durationMs) => {
			const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 10 });
			expect(() => ring.append({ ...logInput("invalid duration"), durationMs })).toThrow(
				/durationMs/,
			);
			expect(ring.snapshot().entries).toEqual([]);
		},
	);

	it.each([
		{ field: "wallTime" as const, value: "not-a-date" },
		{ field: "wallTime" as const, value: "2026-02-30T00:00:00.000Z" },
		{ field: "virtualTime" as const, value: "2026-08-25" },
	])("rejects invalid $field values", ({ field, value }) => {
		const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 10 });
		expect(() => ring.append({ ...logInput("invalid timestamp"), [field]: value })).toThrow(field);
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

	it("adapts plugin messages to instance-scoped structured entries", () => {
		const ring = new StructuredLogRing({ maxBytes: 10_000, maxEntries: 10 });
		const logger = new StructuredPluginLogger({
			clock: new ReadonlyInstanceClock(
				{ instantMs: Date.parse("2026-08-25T10:00:00.000Z"), mode: "pinned" },
				{ nowMilliseconds: () => 0 },
			),
			instanceId: "dev",
			logs: ring,
			nextCorrelationId: () => "correlation-plugin",
			now: () => "2026-08-25T12:00:00.000Z",
			serviceKey: "slack",
		});

		logger.info("ready");
		logger.info("configured", { token: "secret", visible: true });

		expect(ring.snapshot().entries).toEqual([
			expect.objectContaining({
				correlationId: "correlation-plugin",
				instanceId: "dev",
				kind: "plugin",
				message: "ready",
				serviceKey: "slack",
				virtualTime: "2026-08-25T10:00:00.000Z",
				wallTime: "2026-08-25T12:00:00.000Z",
			}),
			expect.objectContaining({ attributes: { token: "[REDACTED]", visible: true } }),
		]);
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
