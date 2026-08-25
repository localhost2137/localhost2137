import { InstanceLifecycleStateOwner, type InstanceLifecycleStatus } from "./lifecycle-state.js";
import type { LifecycleHookRunner } from "./lifecycle-hook-runner.js";
import type { InstanceSeedState } from "./manifests.js";
import { type AnyServiceLifecycle, LifecycleHookError } from "./service-lifecycle.js";

export interface ScenarioSeedPort {
	run(signal: AbortSignal): Promise<void>;
}

export interface SeedStateStore {
	write(state: InstanceSeedState): Promise<SeedStateWriteResult>;
}

type SeedStateWriteResult = Readonly<{ committedWarning: unknown }> | undefined;

export interface InstanceSeedResult {
	readonly committedWarnings: readonly unknown[];
}

export class InstanceStartError extends AggregateError {
	readonly cleanupFailures: readonly LifecycleHookError[];
	readonly startFailure: unknown;

	constructor(startFailure: unknown, cleanupFailures: readonly LifecycleHookError[]) {
		super(
			[startFailure, ...cleanupFailures],
			"Instance start failed and partial startup was stopped.",
		);
		this.name = "InstanceStartError";
		this.startFailure = startFailure;
		this.cleanupFailures = Object.freeze([...cleanupFailures]);
	}
}

export class InstanceStopError extends AggregateError {
	readonly failures: readonly LifecycleHookError[];

	constructor(failures: readonly LifecycleHookError[]) {
		super(
			failures,
			`${failures.length} service stop hook${failures.length === 1 ? "" : "s"} failed.`,
		);
		this.name = "InstanceStopError";
		this.failures = Object.freeze([...failures]);
	}
}

export class SeedNotAllowedError extends Error {
	readonly status: InstanceSeedState["status"];

	constructor(status: InstanceSeedState["status"]) {
		super(`Instance seed cannot run while persisted seed status is ${status}; reset first.`);
		this.name = "SeedNotAllowedError";
		this.status = status;
	}
}

export class InstanceSeedError extends AggregateError {
	constructor(seedFailure: unknown, persistenceFailures: readonly unknown[] = []) {
		super(
			[seedFailure, ...persistenceFailures],
			"Instance seeding failed and requires an explicit reset.",
			{ cause: seedFailure },
		);
		this.name = "InstanceSeedError";
	}

	get seedFailure(): unknown {
		return this.cause;
	}
}

export class InstanceLifecycle {
	readonly #hooks: LifecycleHookRunner;
	readonly #now: () => string;
	readonly #scenarioSeed: ScenarioSeedPort | undefined;
	readonly #seedStateStore: SeedStateStore;
	readonly #services: readonly AnyServiceLifecycle[];
	readonly #signal: AbortSignal;
	readonly #state = new InstanceLifecycleStateOwner();
	#seedState: InstanceSeedState;

	constructor(input: {
		readonly hooks: LifecycleHookRunner;
		readonly now: () => string;
		readonly scenarioSeed?: ScenarioSeedPort;
		readonly seedState: InstanceSeedState;
		readonly seedStateStore: SeedStateStore;
		readonly services: readonly AnyServiceLifecycle[];
		readonly signal: AbortSignal;
	}) {
		this.#hooks = input.hooks;
		this.#now = input.now;
		this.#scenarioSeed = input.scenarioSeed;
		this.#seedState = input.seedState;
		this.#seedStateStore = input.seedStateStore;
		this.#services = Object.freeze([...input.services]);
		this.#signal = input.signal;
	}

	status(): InstanceLifecycleStatus {
		return this.#state.status();
	}

	seedStatus(): InstanceSeedState["status"] {
		return this.#seedState.status;
	}

	beginReset(): void {
		this.#state.beginReset();
	}

	restoreResetFailure(): void {
		this.#state.restoreAfterResetFailure("stopped");
	}

	beginDestroy(): void {
		this.#state.beginDestroy();
	}

	restoreDestroyFailure(): void {
		this.#state.restoreAfterDestroyFailure();
	}

	async start(signal?: AbortSignal): Promise<void> {
		const phaseSignal = this.#phaseSignal(signal);
		this.#state.beginStart();
		const started: AnyServiceLifecycle[] = [];
		try {
			for (const service of this.#services) {
				phaseSignal.throwIfAborted();
				await service.start(phaseSignal);
				started.push(service);
				phaseSignal.throwIfAborted();
			}
			this.#state.startFinished(true);
			if (this.#seedState.status === "seed_failed") this.#state.restoreSeedFailure();
		} catch (startFailure) {
			const cleanupFailures = await stopServices([...started].reverse(), phaseSignal);
			this.#state.startFinished(false, cleanupFailures.length === 0);
			throw new InstanceStartError(startFailure, cleanupFailures);
		}
	}

	async stopAll(signal?: AbortSignal): Promise<void> {
		if (this.#state.status() === "stopped") return;
		this.#state.beginStop();
		const failures = await stopServices([...this.#services].reverse(), this.#phaseSignal(signal));
		this.#state.stopFinished(failures.length === 0);
		if (failures.length > 0) throw new InstanceStopError(failures);
	}

	async seed(signal?: AbortSignal): Promise<InstanceSeedResult> {
		const phaseSignal = this.#phaseSignal(signal);
		if (this.#seedState.status !== "unseeded") {
			throw new SeedNotAllowedError(this.#seedState.status);
		}
		this.#state.beginSeed();
		const attempt = this.#seedState.attempt + 1;
		const seeding: InstanceSeedState = { attempt, status: "seeding" };
		const committedWarnings: unknown[] = [];
		try {
			collectCommittedWarning(await this.#seedStateStore.write(seeding), committedWarnings);
			this.#seedState = seeding;
		} catch (cause) {
			this.#state.seedCancelled();
			throw cause;
		}

		try {
			for (const service of this.#services) {
				phaseSignal.throwIfAborted();
				await service.seed(phaseSignal);
				phaseSignal.throwIfAborted();
			}
			phaseSignal.throwIfAborted();
			if (this.#scenarioSeed) {
				await this.#hooks.run("scenario:seed", phaseSignal, (hookSignal) =>
					this.#scenarioSeed?.run(hookSignal),
				);
			}
			phaseSignal.throwIfAborted();
			const seeded: InstanceSeedState = { attempt, status: "seeded" };
			collectCommittedWarning(await this.#seedStateStore.write(seeded), committedWarnings);
			this.#seedState = seeded;
			this.#state.seedFinished(true);
			return Object.freeze({ committedWarnings: Object.freeze(committedWarnings) });
		} catch (seedFailure) {
			const failed: InstanceSeedState = {
				attempt,
				failure: {
					at: this.#now(),
					...(seedFailure instanceof LifecycleHookError
						? { correlationId: seedFailure.correlationId }
						: {}),
					message: persistedFailureMessage(seedFailure),
				},
				status: "seed_failed",
			};
			this.#seedState = failed;
			const persistenceFailures: unknown[] = [];
			try {
				collectCommittedWarning(await this.#seedStateStore.write(failed), persistenceFailures);
			} catch (cause) {
				persistenceFailures.push(cause);
			}
			this.#state.seedFinished(false);
			throw new InstanceSeedError(seedFailure, [...committedWarnings, ...persistenceFailures]);
		}
	}

	#phaseSignal(signal?: AbortSignal): AbortSignal {
		return !signal || signal === this.#signal
			? this.#signal
			: AbortSignal.any([this.#signal, signal]);
	}
}

function collectCommittedWarning(result: SeedStateWriteResult, warnings: unknown[]): void {
	if (result) warnings.push(result.committedWarning);
}

async function stopServices(
	services: readonly AnyServiceLifecycle[],
	signal: AbortSignal,
): Promise<LifecycleHookError[]> {
	const failures: LifecycleHookError[] = [];
	for (const service of services) {
		if (service.status() !== "running") continue;
		try {
			await service.stop(signal);
		} catch (cause) {
			if (cause instanceof LifecycleHookError) failures.push(cause);
			else throw cause;
		}
	}
	return failures;
}

function persistedFailureMessage(cause: unknown): string {
	return cause instanceof LifecycleHookError
		? "Plugin seed failed; inspect runtime logs using the recorded correlation ID."
		: "Scenario seed failed; inspect runtime logs for details.";
}
