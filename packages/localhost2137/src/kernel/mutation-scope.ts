import type { MonotonicClock } from "./instance-leases.js";
import type { ScheduledTask, TaskScheduler } from "./task-tracker.js";

export class MutationTimeoutError extends Error {
	readonly label: string;
	readonly timeoutMs: number;

	constructor(label: string, timeoutMs: number) {
		super(`Timed out while ${label} after ${timeoutMs}ms.`);
		this.name = "MutationTimeoutError";
		this.label = label;
		this.timeoutMs = timeoutMs;
	}
}

export class MutationAbortedError extends Error {
	override readonly cause: unknown;
	readonly label: string;

	constructor(label: string, cause: unknown) {
		super(`Cancelled while ${label}.`);
		this.name = "MutationAbortedError";
		this.label = label;
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

export interface MutationScopeOptions {
	readonly label: string;
	readonly signals?: readonly AbortSignal[];
	readonly timeoutMs: number;
}

export class MutationScope {
	readonly #clock: MonotonicClock;
	readonly #controller = new AbortController();
	readonly #deadline: number;
	readonly #label: string;
	readonly #listeners: ReadonlyArray<Readonly<{ abort: () => void; signal: AbortSignal }>>;
	readonly #timeout: ScheduledTask;
	readonly #timeoutMs: number;
	#disposed = false;

	constructor(clock: MonotonicClock, scheduler: TaskScheduler, options: MutationScopeOptions) {
		if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
			throw new TypeError("Mutation timeoutMs must be a non-negative safe integer.");
		}
		if (options.label.trim() === "") throw new TypeError("Mutation label must not be empty.");
		const startedAt = clock.nowMilliseconds();
		if (!Number.isFinite(startedAt)) throw new TypeError("Monotonic clock must be finite.");
		this.#clock = clock;
		this.#deadline = startedAt + options.timeoutMs;
		this.#label = options.label;
		this.#timeoutMs = options.timeoutMs;
		this.#listeners = Object.freeze(
			(options.signals ?? []).map((signal) => {
				const abort = () => {
					this.#controller.abort(new MutationAbortedError(this.#label, signal.reason));
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				return Object.freeze({ abort, signal });
			}),
		);
		this.#timeout = scheduler.schedule(options.timeoutMs, () => {
			this.#controller.abort(new MutationTimeoutError(this.#label, this.#timeoutMs));
		});
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	remainingMs(): number {
		const now = this.#clock.nowMilliseconds();
		if (!Number.isFinite(now)) throw new TypeError("Monotonic clock must be finite.");
		return Math.max(0, this.#deadline - now);
	}

	checkpoint(): void {
		if (this.signal.aborted) throw this.signal.reason;
		if (this.remainingMs() === 0) {
			const cause = new MutationTimeoutError(this.#label, this.#timeoutMs);
			this.#controller.abort(cause);
			throw cause;
		}
	}

	async wait<Value>(work: () => Promise<Value>): Promise<Value> {
		this.checkpoint();
		const pending = work();
		let aborted: (() => void) | undefined;
		const cancellation = new Promise<never>((_resolve, reject) => {
			aborted = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", aborted, { once: true });
			if (this.signal.aborted) aborted();
		});
		try {
			const value = await Promise.race([pending, cancellation]);
			this.checkpoint();
			return value;
		} finally {
			if (aborted) this.signal.removeEventListener("abort", aborted);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#timeout.cancel();
		for (const { abort, signal } of this.#listeners) signal.removeEventListener("abort", abort);
	}
}
