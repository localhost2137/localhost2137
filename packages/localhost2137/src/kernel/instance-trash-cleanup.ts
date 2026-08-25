import type { InstanceStoragePort } from "./instance-storage.js";
import { InstanceTaskTracker, type TaskCloseReport, type TaskScheduler } from "./task-tracker.js";

export class InstanceTrashCleanup {
	readonly #storage: InstanceStoragePort;
	readonly #tasks: InstanceTaskTracker;

	constructor(storage: InstanceStoragePort, scheduler: TaskScheduler) {
		this.#storage = storage;
		this.#tasks = new InstanceTaskTracker(scheduler);
	}

	schedule(trashId: string): void {
		this.#tasks
			.track(`trash:${trashId}`, this.#storage.cleanupTrash(trashId))
			.catch(() => undefined);
	}

	retainFailure(label: string, cause: unknown): void {
		this.#tasks.track(label, Promise.reject(cause)).catch(() => undefined);
	}

	close(graceMs: number): Promise<TaskCloseReport> {
		return this.#tasks.close({ graceMs });
	}
}
