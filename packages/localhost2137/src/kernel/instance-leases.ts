import type { ScheduledTask, TaskScheduler } from "./task-tracker.js";

export interface MonotonicClock {
	nowMilliseconds(): number;
}

export interface TrackedTaskDrain {
	idle(options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>): Promise<void>;
}

export interface InstanceLease {
	release(): void;
}

export interface ExclusiveLeaseOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
}

export class LeaseTimeoutError extends Error {
	readonly activeSharedLeases: number;

	constructor(activeSharedLeases: number) {
		super(`Timed out waiting for ${activeSharedLeases} shared instance lease(s) to finish.`);
		this.name = "LeaseTimeoutError";
		this.activeSharedLeases = activeSharedLeases;
	}
}

export class LeaseAbortedError extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super("Waiting for an instance lease was aborted.");
		this.name = "LeaseAbortedError";
		this.cause = cause;
	}
}

export class LeaseRetiredError extends Error {
	constructor() {
		super("The active instance generation was retired during a lifecycle change.");
		this.name = "LeaseRetiredError";
	}
}

interface QueuedWaiter {
	readonly cancel: (cause: Error) => void;
	readonly grant: () => void;
}

export class InstanceLeaseCoordinator {
	readonly #clock: MonotonicClock;
	readonly #exclusiveQueue: QueuedWaiter[] = [];
	readonly #scheduler: TaskScheduler;
	readonly #sharedQueue: QueuedWaiter[] = [];
	readonly #tasks: TrackedTaskDrain;
	#activeExclusive = false;
	#activeShared = 0;
	#retired = false;

	constructor(tasks: TrackedTaskDrain, scheduler: TaskScheduler, clock: MonotonicClock) {
		this.#tasks = tasks;
		this.#scheduler = scheduler;
		this.#clock = clock;
	}

	acquireShared(signal?: AbortSignal): Promise<InstanceLease> {
		if (this.#retired) return Promise.reject(new LeaseRetiredError());
		if (signal?.aborted) return Promise.reject(new LeaseAbortedError(signal.reason));
		if (!this.#activeExclusive && this.#exclusiveQueue.length === 0) {
			return Promise.resolve(this.#grantSharedLease());
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const cancel = (cause: Error) => {
				if (settled) return;
				settled = true;
				removeWaiter(this.#sharedQueue, waiter);
				signal?.removeEventListener("abort", abort);
				reject(cause);
			};
			const abort = () => cancel(new LeaseAbortedError(signal?.reason));
			const grant = () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve(this.#grantSharedLease());
			};
			const waiter: QueuedWaiter = { cancel, grant };
			this.#sharedQueue.push(waiter);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}

	async acquireExclusive(options: ExclusiveLeaseOptions): Promise<InstanceLease> {
		validateTimeout(options.timeoutMs);
		if (this.#retired) throw new LeaseRetiredError();
		const deadline = this.#clock.nowMilliseconds() + options.timeoutMs;
		const lease = await this.#waitForExclusive(options);
		try {
			const remaining = Math.max(0, deadline - this.#clock.nowMilliseconds());
			await this.#tasks.idle({
				...(options.signal ? { signal: options.signal } : {}),
				timeoutMs: remaining,
			});
			return lease;
		} catch (cause) {
			lease.release();
			throw cause;
		}
	}

	retire(): void {
		if (this.#retired) return;
		this.#retired = true;
		const cause = new LeaseRetiredError();
		for (const waiter of [...this.#exclusiveQueue]) waiter.cancel(cause);
		for (const waiter of [...this.#sharedQueue]) waiter.cancel(cause);
	}

	#waitForExclusive(options: ExclusiveLeaseOptions): Promise<InstanceLease> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let timeout: ScheduledTask | undefined;
			const cleanup = () => {
				timeout?.cancel();
				options.signal?.removeEventListener("abort", abort);
			};
			const cancel = (cause: Error) => {
				if (settled) return;
				settled = true;
				removeWaiter(this.#exclusiveQueue, waiter);
				cleanup();
				reject(cause);
				this.#pump();
			};
			const abort = () => cancel(new LeaseAbortedError(options.signal?.reason));
			const grant = () => {
				if (settled) return;
				settled = true;
				cleanup();
				this.#activeExclusive = true;
				resolve(this.#exclusiveLease());
			};
			const waiter: QueuedWaiter = { cancel, grant };
			this.#exclusiveQueue.push(waiter);
			options.signal?.addEventListener("abort", abort, { once: true });
			timeout = this.#scheduler.schedule(options.timeoutMs, () => {
				cancel(new LeaseTimeoutError(this.#activeShared));
			});
			if (options.signal?.aborted) abort();
			this.#pump();
		});
	}

	#grantSharedLease(): InstanceLease {
		this.#activeShared += 1;
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.#activeShared -= 1;
				this.#pump();
			},
		});
	}

	#exclusiveLease(): InstanceLease {
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.#activeExclusive = false;
				this.#pump();
			},
		});
	}

	#pump(): void {
		if (this.#retired) return;
		if (this.#activeExclusive || this.#activeShared > 0) return;
		const exclusive = this.#exclusiveQueue.shift();
		if (exclusive) {
			exclusive.grant();
			return;
		}
		for (const shared of this.#sharedQueue.splice(0)) shared.grant();
	}
}

function removeWaiter(queue: QueuedWaiter[], waiter: QueuedWaiter): void {
	const index = queue.indexOf(waiter);
	if (index >= 0) queue.splice(index, 1);
}

function validateTimeout(timeoutMs: number): void {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new TypeError("Exclusive lease timeoutMs must be a non-negative finite number.");
	}
}
