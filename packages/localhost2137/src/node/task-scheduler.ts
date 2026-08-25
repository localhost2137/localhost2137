import type { ScheduledTask, TaskScheduler } from "../kernel/task-tracker.js";

export const nodeTaskScheduler: TaskScheduler = Object.freeze({
	schedule(delayMs: number, callback: () => void): ScheduledTask {
		const timer = setTimeout(callback, delayMs);
		return Object.freeze({ cancel: () => clearTimeout(timer) });
	},
});
