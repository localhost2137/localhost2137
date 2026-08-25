import type { TaskTracker } from "../authoring/context.js";

export interface ScheduledTask {
	cancel(): void;
}

export interface TaskScheduler {
	schedule(delayMs: number, callback: () => void): ScheduledTask;
}

export interface TaskFailure {
	readonly cause: unknown;
	readonly label: string;
}

export interface TaskCloseReport {
	readonly failures: readonly TaskFailure[];
	readonly unfinishedLabels: readonly string[];
}

export class TaskTrackerClosedError extends Error {
	constructor() {
		super("Task tracker is closed and cannot accept new work.");
		this.name = "TaskTrackerClosedError";
	}
}

export class TaskIdleTimeoutError extends Error {
	readonly unfinishedLabels: readonly string[];

	constructor(unfinishedLabels: readonly string[]) {
		super(`Timed out waiting for tracked tasks: ${unfinishedLabels.join(", ") || "unknown"}.`);
		this.name = "TaskIdleTimeoutError";
		this.unfinishedLabels = Object.freeze([...unfinishedLabels]);
	}
}

export class TaskIdleAbortedError extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super("Waiting for tracked tasks was aborted.");
		this.name = "TaskIdleAbortedError";
		this.cause = cause;
	}
}

export class TrackedTaskFailuresError extends AggregateError {
	readonly failures: readonly TaskFailure[];

	constructor(failures: readonly TaskFailure[]) {
		super(
			failures.map(({ cause }) => cause),
			`${failures.length} tracked task${failures.length === 1 ? "" : "s"} failed.`,
		);
		this.name = "TrackedTaskFailuresError";
		this.failures = Object.freeze([...failures]);
	}
}

interface WaitOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export class InstanceTaskTracker implements TaskTracker {
	readonly #failures: TaskFailure[] = [];
	readonly #scheduler: TaskScheduler;
	readonly #tasks = new Map<number, string>();
	readonly #waiters = new Set<() => void>();
	#accepting = true;
	#closePromise: Promise<TaskCloseReport> | undefined;
	#nextTaskId = 1;
	#settledPromise: Promise<TaskCloseReport> | undefined;

	constructor(scheduler: TaskScheduler) {
		this.#scheduler = scheduler;
	}

	track<T>(label: string, task: Promise<T>): Promise<T> {
		return this.#track(label, task, true);
	}

	own<T>(label: string, task: Promise<T>): Promise<T> {
		return this.#track(label, task, false);
	}

	#track<T>(label: string, task: Promise<T>, recordFailure: boolean): Promise<T> {
		if (!this.#accepting) throw new TaskTrackerClosedError();
		if (label.trim() === "") throw new TypeError("Tracked task labels must not be empty.");
		const taskId = this.#nextTaskId;
		this.#nextTaskId += 1;
		this.#tasks.set(taskId, label);
		const tracked = task.then(
			(value) => {
				this.#finishTask(taskId);
				return value;
			},
			(cause: unknown) => {
				if (recordFailure) this.#failures.push(Object.freeze({ cause, label }));
				this.#finishTask(taskId);
				throw cause;
			},
		);
		// Tracking owns the background rejection even when a caller intentionally
		// ignores the returned promise. The original rejecting promise remains
		// awaitable and its failure is still surfaced by idle()/close().
		void tracked.catch(() => undefined);
		return tracked;
	}

	async idle(options: WaitOptions = {}): Promise<void> {
		await this.#drain(options);
		const failures = this.#takeFailures();
		if (failures.length > 0) throw new TrackedTaskFailuresError(failures);
	}

	close(options: Readonly<{ graceMs: number; signal?: AbortSignal }>): Promise<TaskCloseReport> {
		if (this.#closePromise) return this.#closePromise;
		this.#accepting = false;
		this.#settledPromise = this.#finishSettlement();
		this.#closePromise = this.#finishClose(options);
		return this.#closePromise;
	}

	settled(): Promise<TaskCloseReport> {
		if (!this.#settledPromise) {
			throw new TypeError("Task tracker settlement is available only after close starts.");
		}
		return this.#settledPromise;
	}

	async #finishClose(
		options: Readonly<{ graceMs: number; signal?: AbortSignal }>,
	): Promise<TaskCloseReport> {
		try {
			await this.#drain({
				...(options.signal ? { signal: options.signal } : {}),
				timeoutMs: options.graceMs,
			});
		} catch (cause) {
			if (!(cause instanceof TaskIdleTimeoutError) && !(cause instanceof TaskIdleAbortedError)) {
				throw cause;
			}
		}
		return Object.freeze({
			failures: Object.freeze(this.#takeFailures()),
			unfinishedLabels: Object.freeze([...this.#tasks.values()]),
		});
	}

	async #finishSettlement(): Promise<TaskCloseReport> {
		await this.#drain({});
		await this.#closePromise;
		return Object.freeze({
			failures: Object.freeze(this.#takeFailures()),
			unfinishedLabels: Object.freeze([]),
		});
	}

	#finishTask(taskId: number): void {
		this.#tasks.delete(taskId);
		this.#notifyWaiters();
	}

	unfinishedLabels(): readonly string[] {
		return Object.freeze([...this.#tasks.values()]);
	}

	async #drain(options: WaitOptions): Promise<void> {
		const cancellation = createWaitCancellation(this.#scheduler, options, () => [
			...this.#tasks.values(),
		]);
		try {
			while (true) {
				cancellation.throwIfCancelled();
				if (this.#tasks.size > 0) await this.#waitForTaskChange(cancellation.signal);
				await Promise.resolve();
				cancellation.throwIfCancelled();
				if (this.#tasks.size === 0) return;
			}
		} finally {
			cancellation.dispose();
		}
	}

	#waitForTaskChange(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const done = () => {
				signal.removeEventListener("abort", aborted);
				this.#waiters.delete(done);
				resolve();
			};
			const aborted = () => {
				this.#waiters.delete(done);
				reject(signal.reason);
			};
			this.#waiters.add(done);
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) aborted();
		});
	}

	#notifyWaiters(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}

	#takeFailures(): TaskFailure[] {
		return this.#failures.splice(0);
	}
}

interface WaitCancellation {
	readonly signal: AbortSignal;
	dispose(): void;
	throwIfCancelled(): void;
}

function createWaitCancellation(
	scheduler: TaskScheduler,
	options: WaitOptions,
	unfinishedLabels: () => readonly string[],
): WaitCancellation {
	if (
		options.timeoutMs !== undefined &&
		(!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
	) {
		throw new TypeError("Task idle timeoutMs must be a non-negative finite number.");
	}
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(new TaskIdleAbortedError(options.signal?.reason));
	options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	if (options.signal?.aborted) abortFromCaller();
	const timeout =
		options.timeoutMs === undefined
			? undefined
			: scheduler.schedule(options.timeoutMs, () => {
					controller.abort(new TaskIdleTimeoutError(unfinishedLabels()));
				});
	return {
		dispose: () => {
			timeout?.cancel();
			options.signal?.removeEventListener("abort", abortFromCaller);
		},
		signal: controller.signal,
		throwIfCancelled: () => {
			if (controller.signal.aborted) throw controller.signal.reason;
		},
	};
}
