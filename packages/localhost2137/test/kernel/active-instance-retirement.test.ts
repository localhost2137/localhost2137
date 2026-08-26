import { describe, expect, it, vi } from "vitest";
import type { ActiveInstance } from "../../src/kernel/active-instance.js";
import { ActiveInstanceGeneration } from "../../src/kernel/active-instance-generation.js";
import { retireActiveInstance } from "../../src/kernel/active-instance-retirement.js";
import { InstanceTaskTracker, TaskTrackerClosedError } from "../../src/kernel/task-tracker.js";
import { nodeTaskScheduler } from "../../src/node/task-scheduler.js";

describe("active instance retirement", () => {
	it("reports cancellation promptly but owns work, stop hooks, and terminal tasks until close", async () => {
		const tasks = new InstanceTaskTracker(nodeTaskScheduler);
		const generation = new ActiveInstanceGeneration(tasks);
		const releaseTerminalWork = deferred<void>();
		const stopEntered = deferred<void>();
		const events: string[] = [];
		let status = "running" as const | "stopped";
		const retireLeases = vi.fn();
		const active = {
			generation,
			leases: { retire: retireLeases },
			lifecycle: {
				status: () => status,
				stopAll: async () => {
					events.push("stop");
					status = "stopped";
					void tasks.track("terminal persistence", releaseTerminalWork.promise);
					stopEntered.resolve(undefined);
				},
			},
			tasks,
		} as unknown as ActiveInstance;
		const activeWork = tasks.track(
			"active delivery",
			abortReason(generation.signal).then(() => void events.push("delivery")),
		);
		const cancellation = new AbortController();
		const reason = new Error("deadline reached");

		const retirement = retireActiveInstance(active, {
			remainingMs: () => 1_000,
			reason: "test retirement",
			signal: cancellation.signal,
		});
		cancellation.abort(reason);

		await expect(retirement.result).rejects.toBe(reason);
		await activeWork;
		await stopEntered.promise;
		expect(retireLeases).toHaveBeenCalledOnce();
		expect(events).toEqual(["delivery", "stop"]);
		expect(generation.signal.aborted).toBe(true);
		expect(settlementProbe(retirement.settled)()).toBe(false);
		expect(() => tasks.track("while retirement is owned", Promise.resolve())).not.toThrow();

		releaseTerminalWork.resolve(undefined);
		await expect(retirement.settled).resolves.toEqual({
			blockingFailures: [],
			taskFailures: [],
		});
		expect(() => tasks.track("after retirement settled", Promise.resolve())).toThrow(
			TaskTrackerClosedError,
		);
	});

	it("classifies recorded task failures separately from blocking cleanup failures", async () => {
		const tasks = new InstanceTaskTracker(nodeTaskScheduler);
		const generation = new ActiveInstanceGeneration(tasks);
		const failure = new Error("delivery failed");
		await tasks.track("delivery", Promise.reject(failure)).catch(() => undefined);
		const active = {
			generation,
			leases: { retire: vi.fn() },
			lifecycle: { status: () => "stopped" },
			tasks,
		} as unknown as ActiveInstance;
		const retirement = retireActiveInstance(active, {
			remainingMs: () => 1_000,
			reason: "test retirement",
			signal: new AbortController().signal,
		});

		const report = await retirement.result;

		expect(report.blockingFailures).toEqual([]);
		expect(report.taskFailures).toEqual([{ cause: failure, label: "delivery" }]);
		await expect(retirement.settled).resolves.toBe(report);
	});
});

function abortReason(signal: AbortSignal): Promise<unknown> {
	if (signal.aborted) return Promise.resolve(signal.reason);
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
	});
}

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}

function settlementProbe(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return () => settled;
}
