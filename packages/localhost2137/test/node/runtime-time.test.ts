import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRuntimeTime } from "../../src/node/runtime-time.js";

afterEach(() => vi.useRealTimers());

describe("NodeRuntimeTime", () => {
	it("reads epoch and RFC 3339 time from the process wall clock", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T12:34:56.789Z"));
		const time = new NodeRuntimeTime();

		expect(time.nowMilliseconds()).toBe(Date.parse("2026-08-25T12:34:56.789Z"));
		expect(time.nowTimestamp()).toBe("2026-08-25T12:34:56.789Z");
	});
});
