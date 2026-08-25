import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeTaskScheduler } from "../../src/node/task-scheduler.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("node task scheduler", () => {
	it("runs scheduled callbacks and supports cancellation", () => {
		vi.useFakeTimers();
		const called: string[] = [];
		nodeTaskScheduler.schedule(10, () => called.push("ran"));
		const cancelled = nodeTaskScheduler.schedule(10, () => called.push("cancelled"));
		cancelled.cancel();
		vi.advanceTimersByTime(10);

		expect(called).toEqual(["ran"]);
	});
});
