import { describe, expect, it } from "vitest";
import {
	InstanceLeaseCoordinator,
	LeaseAbortedError,
	LeaseTimeoutError,
	type MonotonicClock,
} from "../../src/kernel/instance-leases.js";
import {
	InstanceTaskTracker,
	type ScheduledTask,
	TaskIdleTimeoutError,
	type TaskScheduler,
} from "../../src/kernel/task-tracker.js";

class ManualTime implements MonotonicClock, TaskScheduler {
	readonly callbacks = new Set<() => void>();
	now = 0;

	nowMilliseconds(): number {
		return this.now;
	}

	schedule(_delayMs: number, callback: () => void): ScheduledTask {
		this.callbacks.add(callback);
		return { cancel: () => this.callbacks.delete(callback) };
	}

	advanceAndFire(milliseconds: number): void {
		this.now += milliseconds;
		for (const callback of [...this.callbacks]) callback();
	}
}

describe("InstanceLeaseCoordinator", () => {
	it("gives queued exclusive work priority over new shared leases", async () => {
		const time = new ManualTime();
		const tracker = new InstanceTaskTracker(time);
		const leases = new InstanceLeaseCoordinator(tracker, time, time);
		const firstShared = await leases.acquireShared();
		let exclusiveGranted = false;
		const exclusivePromise = leases.acquireExclusive({ timeoutMs: 100 }).then((lease) => {
			exclusiveGranted = true;
			return lease;
		});
		let secondSharedGranted = false;
		const secondSharedPromise = leases.acquireShared().then((lease) => {
			secondSharedGranted = true;
			return lease;
		});

		await Promise.resolve();
		expect({ exclusiveGranted, secondSharedGranted }).toEqual({
			exclusiveGranted: false,
			secondSharedGranted: false,
		});
		firstShared.release();
		const exclusive = await exclusivePromise;
		expect(exclusiveGranted).toBe(true);
		expect(secondSharedGranted).toBe(false);
		exclusive.release();
		const secondShared = await secondSharedPromise;
		expect(secondSharedGranted).toBe(true);
		secondShared.release();
	});

	it("holds exclusivity until tracked tasks finish", async () => {
		const time = new ManualTime();
		const tracker = new InstanceTaskTracker(time);
		const leases = new InstanceLeaseCoordinator(tracker, time, time);
		const task = deferred<void>();
		const tracked = tracker.track("delivery", task.promise);
		let acquired = false;
		const exclusivePromise = leases.acquireExclusive({ timeoutMs: 100 }).then((lease) => {
			acquired = true;
			return lease;
		});
		const sharedPromise = leases.acquireShared();

		await Promise.resolve();
		expect(acquired).toBe(false);
		task.resolve();
		await tracked;
		const exclusive = await exclusivePromise;
		expect(acquired).toBe(true);
		exclusive.release();
		(await sharedPromise).release();
	});

	it("times out a queued exclusive lease and removes it from the queue", async () => {
		const time = new ManualTime();
		const tracker = new InstanceTaskTracker(time);
		const leases = new InstanceLeaseCoordinator(tracker, time, time);
		const shared = await leases.acquireShared();
		const exclusive = leases.acquireExclusive({ timeoutMs: 10 });
		time.advanceAndFire(10);

		await expect(exclusive).rejects.toBeInstanceOf(LeaseTimeoutError);
		const anotherShared = await leases.acquireShared();
		anotherShared.release();
		shared.release();
	});

	it("releases its internal exclusive lease when tracked-task draining times out", async () => {
		const time = new ManualTime();
		const tracker = new InstanceTaskTracker(time);
		const leases = new InstanceLeaseCoordinator(tracker, time, time);
		const task = deferred<void>();
		const tracked = tracker.track("stuck", task.promise);
		const exclusive = leases.acquireExclusive({ timeoutMs: 10 });
		await Promise.resolve();
		time.advanceAndFire(10);

		await expect(exclusive).rejects.toBeInstanceOf(TaskIdleTimeoutError);
		const shared = await leases.acquireShared();
		shared.release();
		task.resolve();
		await tracked;
	});

	it("removes aborted shared and exclusive waiters", async () => {
		const time = new ManualTime();
		const tracker = new InstanceTaskTracker(time);
		const leases = new InstanceLeaseCoordinator(tracker, time, time);
		const exclusive = await leases.acquireExclusive({ timeoutMs: 100 });
		const sharedController = new AbortController();
		const shared = leases.acquireShared(sharedController.signal);
		sharedController.abort("request gone");
		await expect(shared).rejects.toBeInstanceOf(LeaseAbortedError);

		const otherExclusiveController = new AbortController();
		const otherExclusive = leases.acquireExclusive({
			signal: otherExclusiveController.signal,
			timeoutMs: 100,
		});
		otherExclusiveController.abort("shutdown");
		await expect(otherExclusive).rejects.toBeInstanceOf(LeaseAbortedError);
		exclusive.release();
	});
});

function deferred<T>(): Readonly<{
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}> {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
