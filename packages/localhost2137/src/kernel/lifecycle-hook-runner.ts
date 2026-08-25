import type { InstanceTaskTracker } from "./task-tracker.js";

export class LifecycleHookRunner {
	readonly #generationSignal: AbortSignal;
	readonly #tasks: InstanceTaskTracker;

	constructor(tasks: InstanceTaskTracker, generationSignal: AbortSignal) {
		this.#tasks = tasks;
		this.#generationSignal = generationSignal;
	}

	run<Value>(
		label: string,
		signal: AbortSignal | undefined,
		hook: (signal: AbortSignal) => Promise<Value> | Value,
	): Promise<Value> {
		if (label.trim() === "") throw new TypeError("Lifecycle hook labels must not be empty.");
		const phaseSignal =
			signal && signal !== this.#generationSignal
				? AbortSignal.any([this.#generationSignal, signal])
				: this.#generationSignal;
		return this.#tasks.own(
			`lifecycle:${label}`,
			Promise.resolve().then(() => hook(phaseSignal)),
		);
	}
}
