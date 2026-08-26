import { describe, expect, it } from "vitest";
import { parseClockDuration } from "../../src/kernel/clock-duration.js";
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

	it("previews exact pinned and real advances without mutating until replacement", async () => {
		const pinned = new ReadonlyInstanceClock(
			{ instantMs: Date.parse("2026-01-01T00:00:00.000Z"), mode: "pinned" },
			{ nowMilliseconds: () => 0 },
		);
		const pinnedPreview = pinned.previewAdvance(parseClockDuration("30d"));
		expect(await pinned.status()).toEqual({
			mode: "pinned",
			now: "2026-01-01T00:00:00.000Z",
		});
		pinned.replaceState(pinnedPreview.state);
		expect(await pinned.status()).toEqual({
			mode: "pinned",
			now: "2026-01-31T00:00:00.000Z",
		});

		const real = new ReadonlyInstanceClock(
			{ mode: "real", offsetMs: 1_000 },
			{ nowMilliseconds: () => 10_000 },
		);
		expect(real.previewAdvance(parseClockDuration("2s"))).toEqual({
			fromMs: 11_000,
			state: { mode: "real", offsetMs: 3_000 },
			toMs: 13_000,
		});
	});
});

describe("clock duration grammar", () => {
	it.each([
		["1ms", 1],
		["2s", 2_000],
		["3m", 180_000],
		["4h", 14_400_000],
		["30d", 2_592_000_000],
		["2w", 1_209_600_000],
	] as const)("parses %s exactly", (input, expected) => {
		expect(parseClockDuration(input)).toBe(expected);
	});

	it.each([undefined, 1, "", "0ms", "01s", "1.5h", "1month", "-1d", "999999999999999999d"])(
		"rejects ambiguous or unsafe duration %j",
		(input) => {
			expect(() => parseClockDuration(input)).toThrow();
		},
	);
});
