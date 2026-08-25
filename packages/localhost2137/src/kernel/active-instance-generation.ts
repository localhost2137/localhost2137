import type { InstanceTaskTracker, TaskCloseReport } from "./task-tracker.js";

export class ActiveInstanceGeneration {
	readonly #controller = new AbortController();
	readonly #tasks: InstanceTaskTracker;
	#closePromise: Promise<TaskCloseReport> | undefined;

	constructor(tasks: InstanceTaskTracker) {
		this.#tasks = tasks;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	close(reason: unknown, graceMs: number): Promise<TaskCloseReport> {
		if (this.#closePromise) return this.#closePromise;
		this.#controller.abort(reason);
		this.#closePromise = this.#tasks.close({ graceMs });
		return this.#closePromise;
	}
}
