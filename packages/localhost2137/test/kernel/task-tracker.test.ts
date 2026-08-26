import { describe, expect, it } from "vitest";
import {
	InstanceTaskTracker,
	type ScheduledTask,
	TaskIdleAbortedError,
	TaskIdleTimeoutError,
	type TaskScheduler,
	TaskTrackerClosedError,
	TrackedTaskFailuresError,
} from "../../src/kernel/task-tracker.js";

class ManualScheduler implements TaskScheduler {
	readonly callbacks = new Set<() => void>();

	schedule(_delayMs: number, callback: () => void): ScheduledTask {
		this.callbacks.add(callback);
		return { cancel: () => this.callbacks.delete(callback) };
	}

	fire(): void {
		for (const callback of [...this.callbacks]) callback();
	}
}

describe("InstanceTaskTracker", () => {
	it("waits for tasks nested by a completing task and decrements in finally", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const parent = deferred<void>();
		const child = deferred<void>();
		let trackedChild: Promise<void> | undefined;
		const trackedParent = tracker.track(
			"parent",
			parent.promise.then(() => {
				trackedChild = tracker.track("child", child.promise);
			}),
		);
		const idle = tracker.idle();
		parent.resolve();
		await trackedParent;
		expect(tracker.unfinishedLabels()).toEqual(["child"]);
		child.resolve();
		await trackedChild;
		await idle;
		expect(tracker.unfinishedLabels()).toEqual([]);
	});

	it("retains task failures until idle surfaces them", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const failure = new Error("delivery failed");
		await expect(tracker.track("delivery", Promise.reject(failure))).rejects.toBe(failure);

		const idle = tracker.idle();
		await expect(idle).rejects.toBeInstanceOf(TrackedTaskFailuresError);
		await expect(idle).rejects.toMatchObject({
			failures: [{ cause: failure, label: "delivery" }],
		});
		await expect(tracker.idle()).resolves.toBeUndefined();
	});

	it("surfaces only failures since a checkpoint and retains older failures", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const olderFailure = new Error("older failure");
		const hookFailure = new Error("hook failure");
		await expect(tracker.track("older", Promise.reject(olderFailure))).rejects.toBe(olderFailure);
		const checkpoint = tracker.failureCheckpoint();
		await expect(tracker.track("hook", Promise.reject(hookFailure))).rejects.toBe(hookFailure);

		await expect(tracker.idleSince(checkpoint)).rejects.toMatchObject({
			failures: [{ cause: hookFailure, label: "hook" }],
		});
		await expect(tracker.idle()).rejects.toMatchObject({
			failures: [{ cause: olderFailure, label: "older" }],
		});
	});

	it("rejects checkpoints captured by another tracker", async () => {
		const first = new InstanceTaskTracker(new ManualScheduler());
		const second = new InstanceTaskTracker(new ManualScheduler());

		await expect(second.idleSince(first.failureCheckpoint())).rejects.toThrow(
			"Task failure checkpoint is invalid for this tracker.",
		);
	});

	it("drains tasks nested after a checkpoint before surfacing their failures", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const parent = deferred<void>();
		const childFailure = new Error("nested hook task failed");
		const checkpoint = tracker.failureCheckpoint();
		const trackedParent = tracker.track(
			"hook parent",
			parent.promise.then(() => {
				tracker.track("hook child", Promise.reject(childFailure));
			}),
		);
		const idle = tracker.idleSince(checkpoint);

		parent.resolve();
		await trackedParent;
		await expect(idle).rejects.toMatchObject({
			failures: [{ cause: childFailure, label: "hook child" }],
		});
	});

	it("owns ignored background rejections while keeping them idle-visible", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const unhandled: unknown[] = [];
		const onUnhandled = (cause: unknown) => unhandled.push(cause);
		process.on("unhandledRejection", onUnhandled);
		try {
			tracker.track("background-delivery", Promise.reject(new Error("background failed")));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(unhandled).toEqual([]);
			await expect(tracker.idle()).rejects.toMatchObject({
				failures: [{ label: "background-delivery" }],
			});
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("times out with the labels that remain unfinished", async () => {
		const scheduler = new ManualScheduler();
		const tracker = new InstanceTaskTracker(scheduler);
		const pending = deferred<void>();
		const tracked = tracker.track("never-finishes", pending.promise);
		const idle = tracker.idle({ timeoutMs: 10 });
		scheduler.fire();

		await expect(idle).rejects.toBeInstanceOf(TaskIdleTimeoutError);
		await expect(idle).rejects.toMatchObject({
			unfinishedLabels: ["never-finishes"],
		});
		pending.resolve();
		await tracked;
	});

	it("observes caller cancellation", async () => {
		const tracker = new InstanceTaskTracker(new ManualScheduler());
		const pending = deferred<void>();
		const tracked = tracker.track("cancelled-wait", pending.promise);
		const controller = new AbortController();
		const idle = tracker.idle({ signal: controller.signal });
		controller.abort("stop");

		await expect(idle).rejects.toBeInstanceOf(TaskIdleAbortedError);
		pending.resolve();
		await tracked;
	});

	it("closes admission and reports unfinished labels after its grace period", async () => {
		const scheduler = new ManualScheduler();
		const tracker = new InstanceTaskTracker(scheduler);
		const pending = deferred<void>();
		const tracked = tracker.track("shutdown-work", pending.promise);
		const close = tracker.close({ graceMs: 25 });
		scheduler.fire();

		await expect(close).resolves.toEqual({
			failures: [],
			unfinishedLabels: ["shutdown-work"],
		});
		expect(() => tracker.track("late", Promise.resolve())).toThrow(TaskTrackerClosedError);
		pending.resolve();
		await tracked;
	});

	it("memoizes concurrent and subsequent close calls with one stable report", async () => {
		const scheduler = new ManualScheduler();
		const tracker = new InstanceTaskTracker(scheduler);
		const pending = deferred<void>();
		const tracked = tracker.track("shutdown-work", pending.promise);
		const first = tracker.close({ graceMs: 25 });
		const concurrent = tracker.close({ graceMs: 999 });
		expect(concurrent).toBe(first);
		scheduler.fire();

		const firstReport = await first;
		const concurrentReport = await concurrent;
		const subsequent = tracker.close({ graceMs: 0 });
		expect(subsequent).toBe(first);
		expect(concurrentReport).toBe(firstReport);
		expect(await subsequent).toBe(firstReport);
		expect(firstReport).toEqual({
			failures: [],
			unfinishedLabels: ["shutdown-work"],
		});

		pending.resolve();
		await tracked;
	});
});

function deferred<T>(): Readonly<{
	promise: Promise<T>;
	reject: (cause?: unknown) => void;
	resolve: (value: T | PromiseLike<T>) => void;
}> {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
	let rejectPromise: (cause?: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}
