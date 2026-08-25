import { describe, expect, it } from "vitest";
import {
	MutationAbortedError,
	MutationScope,
	MutationTimeoutError,
} from "../../src/kernel/mutation-scope.js";
import type { MonotonicClock } from "../../src/kernel/instance-leases.js";
import type { ScheduledTask, TaskScheduler } from "../../src/kernel/task-tracker.js";

class ManualTime implements MonotonicClock, TaskScheduler {
	readonly callbacks = new Set<() => void>();
	now = 0;

	nowMilliseconds(): number {
		return this.now;
	}

	schedule(_delayMs: number, callback: () => void): ScheduledTask {
		this.callbacks.add(callback);
		return Object.freeze({ cancel: () => this.callbacks.delete(callback) });
	}

	advance(milliseconds: number): void {
		this.now += milliseconds;
		for (const callback of [...this.callbacks]) callback();
	}
}

describe("MutationScope", () => {
	it("composes caller cancellation and removes its listener on dispose", () => {
		const time = new ManualTime();
		const caller = new AbortController();
		const scope = new MutationScope(time, time, {
			label: "seeding instance dev",
			signals: [caller.signal],
			timeoutMs: 100,
		});

		caller.abort("request disconnected");

		expect(() => scope.checkpoint()).toThrow(
			expect.objectContaining<Partial<MutationAbortedError>>({
				cause: "request disconnected",
				label: "seeding instance dev",
			}),
		);
		scope.dispose();
		expect(time.callbacks).toHaveLength(0);
	});

	it("shares one monotonic deadline across every awaited phase", async () => {
		const time = new ManualTime();
		const scope = new MutationScope(time, time, {
			label: "resetting instance dev",
			timeoutMs: 10,
		});
		expect(scope.remainingMs()).toBe(10);

		time.advance(10);

		expect(() => scope.checkpoint()).toThrow(MutationTimeoutError);
		await expect(scope.wait(() => Promise.resolve("late"))).rejects.toBeInstanceOf(
			MutationTimeoutError,
		);
		scope.dispose();
	});

	it("interrupts a non-cooperative awaited phase at the shared deadline", async () => {
		const time = new ManualTime();
		const scope = new MutationScope(time, time, {
			label: "closing the runtime",
			timeoutMs: 10,
		});
		const wait = scope.wait(() => new Promise<never>(() => undefined));

		time.advance(10);

		await expect(wait).rejects.toBeInstanceOf(MutationTimeoutError);
		scope.dispose();
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid timeout %s", (timeoutMs) => {
		const time = new ManualTime();
		expect(() => new MutationScope(time, time, { label: "invalid", timeoutMs })).toThrow(TypeError);
	});
});
