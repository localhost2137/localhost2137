import { describe, expect, it } from "vitest";
import { initialClockState, ReadonlyInstanceClock } from "../../src/kernel/instance-clock.js";

describe("per-instance read-only clock", () => {
	it("reads real time with a persisted offset and returns a fresh Date", async () => {
		const wallClock = { nowMilliseconds: () => 1_700_000_000_000 };
		const clock = new ReadonlyInstanceClock({ mode: "real", offsetMs: 3_000 }, wallClock);
		const first = clock.now();
		first.setUTCFullYear(2000);

		expect(clock.now().getTime()).toBe(1_700_000_003_000);
		expect(await clock.status()).toEqual({
			mode: "real",
			now: new Date(1_700_000_003_000).toISOString(),
		});
	});

	it("keeps pinned time independent from wall time", async () => {
		let wallTime = 100;
		const state = initialClockState({ mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" });
		const clock = new ReadonlyInstanceClock(state, { nowMilliseconds: () => wallTime });
		wallTime = 10_000;

		expect(await clock.status()).toEqual({ mode: "pinned", now: "2026-01-01T00:00:00.000Z" });
	});

	it("initializes real clocks without baking wall time into the offset", () => {
		expect(initialClockState({ mode: "real" })).toEqual({
			mode: "real",
			offsetMs: 0,
		});
	});

	it.each([
		{ mode: "pinned" as const, instantMs: 8_640_000_000_000_001 },
		{ mode: "pinned" as const, instantMs: 1.5 },
		{ mode: "real" as const, offsetMs: Number.NaN },
	])("rejects clock state outside the exact Date-millisecond domain", (state) => {
		expect(() => new ReadonlyInstanceClock(state, { nowMilliseconds: () => 0 })).toThrow(
			RangeError,
		);
	});

	it.each([Number.NaN, 1.5, 8_640_000_000_000_001])(
		"rejects invalid real wall time %s",
		(wallTime) => {
			const clock = new ReadonlyInstanceClock(
				{ mode: "real", offsetMs: 0 },
				{ nowMilliseconds: () => wallTime },
			);
			expect(() => clock.now()).toThrow(RangeError);
		},
	);

	it("checks real wall time and offset after addition", () => {
		const clock = new ReadonlyInstanceClock(
			{ mode: "real", offsetMs: 1 },
			{ nowMilliseconds: () => 8_640_000_000_000_000 },
		);

		expect(() => clock.now()).toThrow(/wall time plus offset/);
	});
});
