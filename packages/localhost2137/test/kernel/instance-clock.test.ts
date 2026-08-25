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
});
