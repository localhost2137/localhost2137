import { InstanceLifecycleStateOwner, type InstanceLifecycleStatus } from "./lifecycle-state.js";
import type { InstanceSeedState } from "./manifests.js";
import { type AnyServiceLifecycle, LifecycleHookError } from "./service-lifecycle.js";

export interface ScenarioSeedPort {
	run(signal: AbortSignal): Promise<void>;
}

export interface SeedStateStore {
	write(state: InstanceSeedState): Promise<void>;
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
	readonly seedFailure: unknown;

	constructor(seedFailure: unknown, persistenceFailures: readonly unknown[] = []) {
		super(
			[seedFailure, ...persistenceFailures],
			"Instance seeding failed and requires an explicit reset.",
		);
		this.name = "InstanceSeedError";
		this.seedFailure = seedFailure;
	}
}

export class InstanceLifecycle {
	readonly #now: () => string;
	readonly #scenarioSeed: ScenarioSeedPort | undefined;
	readonly #seedStateStore: SeedStateStore;
	readonly #services: readonly AnyServiceLifecycle[];
	readonly #signal: AbortSignal;
	readonly #state = new InstanceLifecycleStateOwner();
	#seedState: InstanceSeedState;

	constructor(input: {
		readonly now: () => string;
		readonly scenarioSeed?: ScenarioSeedPort;
		readonly seedState: InstanceSeedState;
		readonly seedStateStore: SeedStateStore;
		readonly services: readonly AnyServiceLifecycle[];
		readonly signal: AbortSignal;
	}) {
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

	async start(): Promise<void> {
		this.#state.beginStart();
		const started: AnyServiceLifecycle[] = [];
		try {
			for (const service of this.#services) {
				await service.start();
				started.push(service);
			}
			this.#state.startFinished(true);
			if (this.#seedState.status === "seed_failed") this.#state.restoreSeedFailure();
		} catch (startFailure) {
			const cleanupFailures = await stopServices([...started].reverse());
			this.#state.startFinished(false, cleanupFailures.length === 0);
			throw new InstanceStartError(startFailure, cleanupFailures);
		}
	}

	async stopAll(): Promise<void> {
		if (this.#state.status() === "stopped") return;
		this.#state.beginStop();
		const failures = await stopServices([...this.#services].reverse());
		this.#state.stopFinished(failures.length === 0);
		if (failures.length > 0) throw new InstanceStopError(failures);
	}

	async seed(): Promise<void> {
		if (this.#seedState.status !== "unseeded") {
			throw new SeedNotAllowedError(this.#seedState.status);
		}
		this.#state.beginSeed();
		const attempt = this.#seedState.attempt + 1;
		const seeding: InstanceSeedState = { attempt, status: "seeding" };
		try {
			await this.#seedStateStore.write(seeding);
			this.#seedState = seeding;
		} catch (cause) {
			this.#state.seedCancelled();
			throw cause;
		}

		try {
			for (const service of this.#services) await service.seed();
			await this.#scenarioSeed?.run(this.#signal);
			const seeded: InstanceSeedState = { attempt, status: "seeded" };
			await this.#seedStateStore.write(seeded);
			this.#seedState = seeded;
			this.#state.seedFinished(true);
		} catch (seedFailure) {
			const failed: InstanceSeedState = {
				attempt,
				failure: {
					at: this.#now(),
					...(seedFailure instanceof LifecycleHookError
						? { correlationId: seedFailure.correlationId }
						: {}),
					message: failureMessage(seedFailure),
				},
				status: "seed_failed",
			};
			this.#seedState = failed;
			const persistenceFailures: unknown[] = [];
			try {
				await this.#seedStateStore.write(failed);
			} catch (cause) {
				persistenceFailures.push(cause);
			}
			this.#state.seedFinished(false);
			throw new InstanceSeedError(seedFailure, persistenceFailures);
		}
	}
}

async function stopServices(
	services: readonly AnyServiceLifecycle[],
): Promise<LifecycleHookError[]> {
	const failures: LifecycleHookError[] = [];
	for (const service of services) {
		if (service.status() !== "running") continue;
		try {
			await service.stop();
		} catch (cause) {
			if (cause instanceof LifecycleHookError) failures.push(cause);
			else throw cause;
		}
	}
	return failures;
}

function failureMessage(cause: unknown): string {
	if (cause instanceof LifecycleHookError && cause.cause instanceof Error && cause.cause.message) {
		return `${cause.message} Cause: ${cause.cause.message}`;
	}
	return cause instanceof Error && cause.message ? cause.message : "Unknown seed failure";
}
