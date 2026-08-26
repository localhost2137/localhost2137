import {
	type ActiveInstance,
	type ActiveInstanceFactory,
	type InstanceSummary,
	summarizeInstance,
} from "./active-instance.js";
import {
	type ActiveInstanceRegistry,
	InstanceAlreadyExistsError,
} from "./active-instance-registry.js";
import {
	type ActiveInstanceRetirementReport,
	retireActiveInstance,
} from "./active-instance-retirement.js";
import type { InstanceId } from "./identifiers.js";
import type { MonotonicClock } from "./instance-leases.js";
import type { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import {
	InstanceStagingError,
	type InstanceStoragePort,
	StorageWriteCommittedError,
} from "./instance-storage.js";
import type { InstanceTrashCleanup } from "./instance-trash-cleanup.js";
import { MutationScope } from "./mutation-scope.js";
import type { TaskScheduler } from "./task-tracker.js";

const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
const MAX_ROLLBACK_GRACE_MS = 5_000;

export interface LifecycleMutationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
}

export interface AdmittedMutationOptions extends LifecycleMutationOptions {
	readonly runtimeSignal: AbortSignal;
}

export interface OwnedMutation<Value> {
	readonly result: Promise<Value>;
	readonly settled: Promise<void>;
}

type ResetCompletion = Readonly<{
	failures: readonly unknown[];
	kind: "finalized" | "pending";
}>;

export class InstanceCreationError extends AggregateError {
	constructor(causes: readonly unknown[]) {
		super(causes, "Instance creation failed; its partial storage was quarantined.");
		this.name = "InstanceCreationError";
	}
}

export class InstanceResetError extends AggregateError {
	constructor(causes: readonly unknown[]) {
		super(causes, "Instance reset failed; the prior instance was restored when possible.");
		this.name = "InstanceResetError";
	}
}

export class InstanceMutationCommittedError extends AggregateError {
	readonly operation: "destroy" | "reset" | "seed";
	readonly summary?: InstanceSummary;

	constructor(
		operation: "destroy" | "reset" | "seed",
		causes: readonly unknown[],
		summary?: InstanceSummary,
	) {
		super(
			causes,
			`Instance ${operation} committed, but its caller deadline or finalization failed.`,
		);
		this.name = "InstanceMutationCommittedError";
		this.operation = operation;
		if (summary) this.summary = summary;
	}
}

export class DurableInstanceMutations {
	readonly #factory: ActiveInstanceFactory;
	readonly #manifests: InstanceManifestPolicy;
	readonly #monotonicClock: MonotonicClock;
	readonly #registry: ActiveInstanceRegistry;
	readonly #scheduler: TaskScheduler;
	readonly #storage: InstanceStoragePort;
	readonly #trash: InstanceTrashCleanup;

	constructor(input: {
		readonly factory: ActiveInstanceFactory;
		readonly manifests: InstanceManifestPolicy;
		readonly monotonicClock: MonotonicClock;
		readonly registry: ActiveInstanceRegistry;
		readonly scheduler: TaskScheduler;
		readonly storage: InstanceStoragePort;
		readonly trash: InstanceTrashCleanup;
	}) {
		this.#factory = input.factory;
		this.#manifests = input.manifests;
		this.#monotonicClock = input.monotonicClock;
		this.#registry = input.registry;
		this.#scheduler = input.scheduler;
		this.#storage = input.storage;
		this.#trash = input.trash;
	}

	create(
		instanceId: InstanceId,
		options: Readonly<{
			persistence: "ephemeral" | "persistent";
			runtimeSignal: AbortSignal;
			seed: boolean;
			signal?: AbortSignal;
			timeoutMs?: number;
		}>,
	): OwnedMutation<InstanceSummary> {
		const scope = this.#scope(`creating instance ${instanceId.value}`, {
			runtimeSignal: options.runtimeSignal,
			...(options.signal ? { signal: options.signal } : {}),
			timeoutMs: options.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
		});
		return this.#owned(scope, this.#create(instanceId, options, scope));
	}

	async #create(
		instanceId: InstanceId,
		options: Readonly<{ persistence: "ephemeral" | "persistent"; seed: boolean }>,
		scope: MutationScope,
	): Promise<InstanceSummary> {
		const releaseReservation = this.#registry.reserve(instanceId);
		try {
			await scope.wait(() => this.#storage.initialize());
			if (await scope.wait(() => this.#storage.readInstance(instanceId))) {
				throw new InstanceAlreadyExistsError(instanceId.value);
			}
			return await this.#createReserved(instanceId, options, scope);
		} finally {
			releaseReservation();
		}
	}

	seed(instanceId: InstanceId, options: AdmittedMutationOptions): OwnedMutation<void> {
		const scope = this.#scope(`seeding instance ${instanceId.value}`, options);
		return this.#owned(scope, this.#seed(instanceId, scope));
	}

	async #seed(instanceId: InstanceId, scope: MutationScope): Promise<void> {
		const active = this.#registry.get(instanceId);
		let committed = false;
		const lease = await active.leases.acquireExclusive({
			signal: scope.signal,
			timeoutMs: scope.remainingMs(),
		});
		try {
			await this.#finalizePendingReset(active, scope);
			const result = await active.lifecycle.seed(scope.signal);
			committed = active.lifecycle.seedStatus() === "seeded";
			await active.tasks.idle({ signal: scope.signal, timeoutMs: scope.remainingMs() });
			scope.checkpoint();
			if (result.committedWarnings.length > 0) {
				throw new InstanceMutationCommittedError("seed", result.committedWarnings);
			}
		} catch (cause) {
			if (cause instanceof InstanceMutationCommittedError) throw cause;
			if (committed) throw new InstanceMutationCommittedError("seed", [cause]);
			throw cause;
		} finally {
			lease.release();
		}
	}

	destroy(instanceId: InstanceId, options: AdmittedMutationOptions): OwnedMutation<void> {
		const scope = this.#scope(`destroying instance ${instanceId.value}`, options);
		return this.#owned(scope, this.#destroy(instanceId, options, scope));
	}

	async #destroy(
		instanceId: InstanceId,
		options: AdmittedMutationOptions,
		scope: MutationScope,
	): Promise<void> {
		const previous = this.#registry.get(instanceId);
		const lease = await previous.leases.acquireRetirement({
			signal: scope.signal,
			timeoutMs: scope.remainingMs(),
		});
		const transition = this.#manifests.transition(instanceId, "destroy");
		let staged = false;
		try {
			await this.#finalizePendingReset(previous, scope);
			const retirement = await this.#retire(previous, scope, "instance destroyed");
			if (retirement.blockingFailures.length > 0) {
				throw new AggregateError(retirement.blockingFailures);
			}
			scope.checkpoint();
			previous.lifecycle.beginDestroy();
			scope.checkpoint();
			try {
				await this.#storage.stageInstance(instanceId, transition);
				staged = true;
			} catch (cause) {
				if (!(cause instanceof InstanceStagingError) || !cause.staged) throw cause;
				staged = true;
				this.#registry.remove(previous);
				this.#trash.schedule(transition.transitionId);
				throw new InstanceMutationCommittedError("destroy", [cause]);
			}
			this.#registry.remove(previous);
			this.#trash.schedule(transition.transitionId);
			scope.checkpoint();
		} catch (cause) {
			if (cause instanceof InstanceMutationCommittedError) throw cause;
			if (staged) throw new InstanceMutationCommittedError("destroy", [cause]);
			const recoveryFailures = await this.#restorePrevious(previous, options);
			throw new AggregateError(
				[cause, ...recoveryFailures],
				"Instance destroy failed and a new generation was restored when possible.",
			);
		} finally {
			lease.release();
		}
	}

	reset(
		instanceId: InstanceId,
		options: AdmittedMutationOptions & Readonly<{ seed: boolean }>,
	): OwnedMutation<InstanceSummary> {
		const scope = this.#scope(`resetting instance ${instanceId.value}`, options);
		return this.#owned(scope, this.#reset(instanceId, options, scope));
	}

	async #reset(
		instanceId: InstanceId,
		options: AdmittedMutationOptions & Readonly<{ seed: boolean }>,
		scope: MutationScope,
	): Promise<InstanceSummary> {
		const previous = this.#registry.get(instanceId);
		const lease = await previous.leases.acquireRetirement({
			signal: scope.signal,
			timeoutMs: scope.remainingMs(),
		});
		const transition = this.#manifests.transition(instanceId, "reset");
		let replacement: ActiveInstance | undefined;
		let staged = false;
		let committed = false;
		let committedSummary: InstanceSummary | undefined;
		try {
			await this.#finalizePendingReset(previous, scope);
			const retirement = await this.#retire(previous, scope, "instance reset");
			if (retirement.blockingFailures.length > 0) {
				throw new AggregateError(retirement.blockingFailures);
			}
			scope.checkpoint();
			previous.lifecycle.beginReset();
			scope.checkpoint();
			try {
				await this.#storage.stageInstance(instanceId, transition);
				staged = true;
			} catch (cause) {
				if (!(cause instanceof InstanceStagingError) || !cause.staged) throw cause;
				staged = true;
			}
			const manifest = this.#manifests.create(
				instanceId,
				previous.manifest.persistence,
				transition.transitionId,
			);
			await scope.wait(() => this.#storage.createInstance(instanceId, manifest));
			const startedReplacement = await this.#factory.start(
				instanceId,
				manifest,
				this.#factoryOptions(scope),
			);
			replacement = startedReplacement;
			if (options.seed) {
				const result = await startedReplacement.lifecycle.seed(scope.signal);
				if (result.committedWarnings.length > 0) {
					throw new AggregateError(result.committedWarnings, "Reset seed storage sync failed.");
				}
				await startedReplacement.tasks.idle({
					signal: scope.signal,
					timeoutMs: scope.remainingMs(),
				});
			}
			const summary = await scope.wait(() => summarizeInstance(startedReplacement));
			startedReplacement.pendingResetTransition = transition;
			const readyWarning = await this.#writeReady(startedReplacement, scope);
			committed = true;
			committedSummary = summary;
			const completionFailures: unknown[] = readyWarning ? [readyWarning] : [];
			try {
				const completion = await this.#completePendingReset(startedReplacement, scope);
				completionFailures.push(...completion.failures);
			} catch (cause) {
				completionFailures.push(cause);
			}
			this.#registry.replace(previous, startedReplacement);
			if (completionFailures.length > 0) {
				throw new InstanceMutationCommittedError("reset", completionFailures, summary);
			}
			return summary;
		} catch (cause) {
			if (cause instanceof InstanceMutationCommittedError) throw cause;
			if (committed) {
				throw new InstanceMutationCommittedError("reset", [cause], committedSummary);
			}
			const rollbackFailures = await this.#rollbackReset(
				previous,
				replacement,
				transition.transitionId,
				staged,
				scope,
				options,
			);
			throw new InstanceResetError([cause, ...rollbackFailures]);
		} finally {
			lease.release();
		}
	}

	async #createReserved(
		instanceId: InstanceId,
		options: Readonly<{ persistence: "ephemeral" | "persistent"; seed: boolean }>,
		scope: MutationScope,
	): Promise<InstanceSummary> {
		let active: ActiveInstance | undefined;
		const trashId = this.#manifests.creationTrashId(instanceId);
		try {
			const manifest = this.#manifests.create(instanceId, options.persistence);
			await scope.wait(() => this.#storage.createInstance(instanceId, manifest));
			const started = await this.#factory.start(instanceId, manifest, this.#factoryOptions(scope));
			active = started;
			if (options.seed) {
				const result = await started.lifecycle.seed(scope.signal);
				if (result.committedWarnings.length > 0) {
					throw new AggregateError(result.committedWarnings, "Create seed storage sync failed.");
				}
				await started.tasks.idle({ signal: scope.signal, timeoutMs: scope.remainingMs() });
			}
			const readyWarning = await this.#writeReady(started, scope);
			if (readyWarning) throw readyWarning;
			const summary = await scope.wait(() => summarizeInstance(started));
			this.#registry.add(started);
			return summary;
		} catch (cause) {
			const cleanupFailures = active
				? [...(await this.#retire(active, scope, cause)).blockingFailures]
				: [];
			let hasActiveStorage = false;
			try {
				hasActiveStorage = (await this.#storage.readInstance(instanceId)) !== undefined;
			} catch (failure) {
				cleanupFailures.push(failure);
			}
			if (hasActiveStorage) {
				let quarantined = false;
				try {
					await this.#storage.quarantineActiveInstance(instanceId, trashId);
					quarantined = true;
				} catch (failure) {
					cleanupFailures.push(failure);
				}
				if (quarantined) this.#trash.schedule(trashId);
			}
			throw new InstanceCreationError([cause, ...cleanupFailures]);
		}
	}

	async #rollbackReset(
		previous: ActiveInstance,
		replacement: ActiveInstance | undefined,
		transitionId: string,
		staged: boolean,
		scope: MutationScope,
		options: AdmittedMutationOptions,
	): Promise<unknown[]> {
		const failures = replacement
			? [...(await this.#retire(replacement, scope, "reset rolled back")).blockingFailures]
			: [];
		if (staged) {
			await this.#storage
				.discardActiveReplacement(previous.id, transitionId)
				.catch((failure: unknown) => failures.push(failure));
			await this.#storage
				.restoreStagedInstance(previous.id, transitionId)
				.catch((failure: unknown) => failures.push(failure));
			this.#trash.schedule(transitionId);
		}
		failures.push(...(await this.#restorePrevious(previous, options)));
		return failures;
	}

	async #restorePrevious(
		previous: ActiveInstance,
		options: AdmittedMutationOptions,
	): Promise<unknown[]> {
		const failures: unknown[] = [];
		const recovery = new MutationScope(this.#monotonicClock, this.#scheduler, {
			label: `restoring instance ${previous.id.value} after a failed mutation`,
			signals: [options.runtimeSignal],
			timeoutMs: Math.max(1, Math.min(options.timeoutMs, MAX_ROLLBACK_GRACE_MS)),
		});
		try {
			const restored = await this.#factory.start(
				previous.id,
				previous.manifest,
				this.#factoryOptions(recovery),
			);
			this.#registry.replace(previous, restored);
		} catch (failure) {
			failures.push(failure);
			this.#registry.remove(previous);
		} finally {
			recovery.dispose();
		}
		return failures;
	}

	async #retire(
		active: ActiveInstance,
		scope: MutationScope,
		reason: unknown,
	): Promise<ActiveInstanceRetirementReport> {
		const retirement = retireActiveInstance(active, {
			remainingMs: () => scope.remainingMs(),
			reason,
			signal: scope.signal,
		});
		// Mutations expose their caller deadline through OwnedMutation.result, but
		// continue owning retirement through OwnedMutation.settled.
		return retirement.settled;
	}

	async #writeReady(
		active: ActiveInstance,
		scope: MutationScope,
	): Promise<StorageWriteCommittedError | undefined> {
		const ready = this.#manifests.markReady(active.manifest);
		scope.checkpoint();
		let warning: StorageWriteCommittedError | undefined;
		try {
			await this.#storage.writeInstance(active.id, ready);
		} catch (cause) {
			if (!isCommittedWrite(cause, "write_instance")) throw cause;
			warning = cause;
		}
		active.manifest = ready;
		return warning;
	}

	async #finalizePendingReset(active: ActiveInstance, scope: MutationScope): Promise<void> {
		const completion = await this.#completePendingReset(active, scope);
		if (completion.failures.length === 0) return;
		throw new AggregateError(
			completion.failures,
			completion.kind === "finalized"
				? `Reset finalization for instance "${active.id.value}" committed with durability warnings.`
				: `Reset finalization for instance "${active.id.value}" remains pending.`,
		);
	}

	async #completePendingReset(
		active: ActiveInstance,
		scope: MutationScope,
	): Promise<ResetCompletion> {
		const transitionId = active.manifest.transition?.id;
		if (!transitionId) return Object.freeze({ failures: Object.freeze([]), kind: "finalized" });
		const pending = active.pendingResetTransition;
		if (!pending || pending.transitionId !== transitionId) {
			throw new TypeError(`Active instance "${active.id.value}" has incomplete reset metadata.`);
		}
		const failures: unknown[] = [];
		scope.checkpoint();
		try {
			await this.#storage.commitTransition(pending);
		} catch (cause) {
			failures.push(cause);
			if (!isCommittedWrite(cause, "commit_transition")) {
				return resetCompletion("pending", failures);
			}
		}
		if (scope.signal.aborted) {
			failures.push(scope.signal.reason);
			return resetCompletion("pending", failures);
		}
		const finalized = this.#manifests.clearTransition(active.manifest);
		try {
			await this.#storage.writeInstance(active.id, finalized);
		} catch (cause) {
			failures.push(cause);
			if (!isCommittedWrite(cause, "write_instance")) {
				return resetCompletion("pending", failures);
			}
		}
		active.manifest = finalized;
		delete active.pendingResetTransition;
		this.#trash.schedule(transitionId);
		return resetCompletion("finalized", failures);
	}

	#factoryOptions(scope: MutationScope): Readonly<{
		remainingMs: () => number;
		signal: AbortSignal;
	}> {
		return { remainingMs: () => scope.remainingMs(), signal: scope.signal };
	}

	#scope(label: string, options: AdmittedMutationOptions): MutationScope {
		return new MutationScope(this.#monotonicClock, this.#scheduler, {
			label,
			signals: [...(options.signal ? [options.signal] : []), options.runtimeSignal],
			timeoutMs: options.timeoutMs,
		});
	}

	#owned<Value>(scope: MutationScope, work: Promise<Value>): OwnedMutation<Value> {
		const owned = work.finally(() => scope.dispose());
		return Object.freeze({
			result: scope.report(owned),
			settled: owned.then(
				() => undefined,
				() => undefined,
			),
		});
	}
}

function resetCompletion(
	kind: ResetCompletion["kind"],
	failures: readonly unknown[],
): ResetCompletion {
	return Object.freeze({ failures: Object.freeze([...failures]), kind });
}

function isCommittedWrite(
	cause: unknown,
	operation: "commit_transition" | "write_instance",
): cause is StorageWriteCommittedError {
	return cause instanceof StorageWriteCommittedError && cause.operation === operation;
}
