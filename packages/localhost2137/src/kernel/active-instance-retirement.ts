import type { ActiveInstance } from "./active-instance.js";
import {
	type TaskFailure,
	TaskIdleAbortedError,
	TaskIdleTimeoutError,
	TrackedTaskFailuresError,
} from "./task-tracker.js";

export interface ActiveInstanceRetirementReport {
	/** Failures that mean lifecycle or resource ownership could not be completed cleanly. */
	readonly blockingFailures: readonly unknown[];
	/** Background task failures observed while the generation was drained. */
	readonly taskFailures: readonly TaskFailure[];
}

/**
 * Retirement has two completion boundaries. `result` observes the caller's
 * deadline, while `settled` retains ownership until every task and stop hook
 * has finished and the generation is closed. Callers that own resources must
 * await `settled` before releasing them, even when `result` has rejected.
 */
export interface ActiveInstanceRetirement {
	readonly result: Promise<ActiveInstanceRetirementReport>;
	readonly settled: Promise<ActiveInstanceRetirementReport>;
}

export function retireActiveInstance(
	active: ActiveInstance,
	input: Readonly<{
		remainingMs: () => number;
		reason: unknown;
		signal: AbortSignal;
	}>,
): ActiveInstanceRetirement {
	active.leases.retire();
	const abortGeneration = () => active.generation.abort(input.signal.reason ?? input.reason);
	input.signal.addEventListener("abort", abortGeneration, { once: true });
	if (input.signal.aborted) abortGeneration();

	const settled = settleRetirement(active, input).finally(() => {
		input.signal.removeEventListener("abort", abortGeneration);
	});
	const result = reportUntilCancellation(settled, input.signal);
	// A resource owner may intentionally await only `settled`; the deadline view
	// must not then become an unhandled rejection.
	void result.catch(() => undefined);
	return Object.freeze({ result, settled });
}

async function settleRetirement(
	active: ActiveInstance,
	input: Readonly<{
		remainingMs: () => number;
		reason: unknown;
		signal: AbortSignal;
	}>,
): Promise<ActiveInstanceRetirementReport> {
	const blockingFailures: unknown[] = [];
	const taskFailures: TaskFailure[] = [];

	await drainTrackedWork(active, input, blockingFailures, taskFailures);
	if (active.lifecycle.status() === "running" || active.lifecycle.status() === "seed_failed") {
		await active.lifecycle
			.stopAll(input.signal)
			.catch((failure: unknown) => blockingFailures.push(failure));
	}
	// Stop hooks may enqueue terminal persistence work. Keep the tracker and its
	// resources open until that work has reached a terminal state.
	await drainTrackedWork(active, input, blockingFailures, taskFailures);

	const closeReport = await active.generation.close(input.reason, input.remainingMs());
	taskFailures.push(...closeReport.failures);
	if (closeReport.unfinishedLabels.length > 0) {
		blockingFailures.push(new ActiveInstanceRetirementOwnershipError(closeReport.unfinishedLabels));
	}
	const settlement = await active.generation.settled();
	taskFailures.push(...settlement.failures);
	if (settlement.unfinishedLabels.length > 0) {
		blockingFailures.push(new ActiveInstanceRetirementOwnershipError(settlement.unfinishedLabels));
	}

	return Object.freeze({
		blockingFailures: Object.freeze([...blockingFailures]),
		taskFailures: Object.freeze([...taskFailures]),
	});
}

async function drainTrackedWork(
	active: ActiveInstance,
	input: Readonly<{ remainingMs: () => number; reason: unknown; signal: AbortSignal }>,
	blockingFailures: unknown[],
	taskFailures: TaskFailure[],
): Promise<void> {
	try {
		await active.tasks.idle({ signal: input.signal, timeoutMs: input.remainingMs() });
		return;
	} catch (cause) {
		if (cause instanceof TrackedTaskFailuresError) {
			taskFailures.push(...cause.failures);
			return;
		}
		if (!(cause instanceof TaskIdleTimeoutError) && !(cause instanceof TaskIdleAbortedError)) {
			blockingFailures.push(cause);
			return;
		}
	}

	// The deadline ends the caller-facing result, not resource ownership. Abort
	// cooperative work and retain the instance until even non-cooperative work
	// has settled, so it cannot use closed storage later.
	active.generation.abort(input.signal.reason ?? input.reason);
	try {
		await active.tasks.idle();
	} catch (cause) {
		if (cause instanceof TrackedTaskFailuresError) taskFailures.push(...cause.failures);
		else blockingFailures.push(cause);
	}
}

function reportUntilCancellation<Value>(
	owned: Promise<Value>,
	signal: AbortSignal,
): Promise<Value> {
	if (signal.aborted) return Promise.reject(signal.reason);
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	return Promise.race([owned, cancelled]).finally(() => {
		if (abort) signal.removeEventListener("abort", abort);
	});
}

class ActiveInstanceRetirementOwnershipError extends Error {
	readonly unfinishedTaskLabels: readonly string[];

	constructor(unfinishedTaskLabels: readonly string[]) {
		super(
			`Instance retirement reached generation close with unfinished tasks: ${unfinishedTaskLabels.join(", ") || "unknown"}.`,
		);
		this.name = "ActiveInstanceRetirementOwnershipError";
		this.unfinishedTaskLabels = Object.freeze([...unfinishedTaskLabels]);
	}
}
