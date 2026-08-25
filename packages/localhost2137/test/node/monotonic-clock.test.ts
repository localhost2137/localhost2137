import { describe, expect, it } from "vitest";
import { nodeMonotonicClock } from "../../src/node/monotonic-clock.js";

describe("node monotonic clock", () => {
	it("never moves backwards between adjacent reads", () => {
		const first = nodeMonotonicClock.nowMilliseconds();
		const second = nodeMonotonicClock.nowMilliseconds();
		expect(second).toBeGreaterThanOrEqual(first);
	});
});
