import { describe, expect, it } from "vitest";
import {
	type MutationAbortedError,
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

	it("reports a deadline without abandoning owned non-cooperative work", async () => {
		const time = new ManualTime();
		const scope = new MutationScope(time, time, {
			label: "closing the runtime",
			timeoutMs: 10,
		});
		let release!: () => void;
		const owned = scope.wait(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const report = scope.report(owned);

		time.advance(10);

		await expect(report).rejects.toBeInstanceOf(MutationTimeoutError);
		let settled = false;
		void owned.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await expect(owned).rejects.toBeInstanceOf(MutationTimeoutError);
		scope.dispose();
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid timeout %s", (timeoutMs) => {
		const time = new ManualTime();
		expect(() => new MutationScope(time, time, { label: "invalid", timeoutMs })).toThrow(TypeError);
	});
});
