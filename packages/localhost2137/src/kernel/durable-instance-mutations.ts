import type { ActiveInstanceFactory } from "./active-instance.js";
import { type ActiveInstance, type InstanceSummary, summarizeInstance } from "./active-instance.js";
import {
	type ActiveInstanceRegistry,
	InstanceAlreadyExistsError,
} from "./active-instance-registry.js";
import type { InstanceId } from "./identifiers.js";
import type { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import { InstanceStagingError, type InstanceStoragePort } from "./instance-storage.js";
import type { InstanceTrashCleanup } from "./instance-trash-cleanup.js";

export interface LifecycleMutationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
}

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

export class DurableInstanceMutations {
	readonly #factory: ActiveInstanceFactory;
	readonly #manifests: InstanceManifestPolicy;
	readonly #registry: ActiveInstanceRegistry;
	readonly #storage: InstanceStoragePort;
	readonly #trash: InstanceTrashCleanup;

	constructor(input: {
		readonly factory: ActiveInstanceFactory;
		readonly manifests: InstanceManifestPolicy;
		readonly registry: ActiveInstanceRegistry;
		readonly storage: InstanceStoragePort;
		readonly trash: InstanceTrashCleanup;
	}) {
		this.#factory = input.factory;
		this.#manifests = input.manifests;
		this.#registry = input.registry;
		this.#storage = input.storage;
		this.#trash = input.trash;
	}

	async create(
		instanceId: InstanceId,
		options: Readonly<{ persistence: "ephemeral" | "persistent"; seed: boolean }>,
	): Promise<InstanceSummary> {
		const releaseReservation = this.#registry.reserve(instanceId);
		try {
			if (await this.#storage.readInstance(instanceId)) {
				throw new InstanceAlreadyExistsError(instanceId.value);
			}
			return await this.#createReserved(instanceId, options);
		} finally {
			releaseReservation();
		}
	}

	async destroy(instanceId: InstanceId, options: LifecycleMutationOptions): Promise<void> {
		const active = this.#registry.get(instanceId);
		const lease = await active.leases.acquireExclusive(options);
		const transition = this.#manifests.transition(instanceId, "destroy");
		try {
			await active.lifecycle.stopAll();
			active.lifecycle.beginDestroy();
			await this.#storage.stageInstance(instanceId, transition);
			this.#registry.remove(active);
			active.leases.retire();
			this.#trash.schedule(transition.transitionId);
		} catch (cause) {
			const recoveryFailures: unknown[] = [];
			if (cause instanceof InstanceStagingError && cause.staged) {
				await this.#storage
					.restoreStagedInstance(instanceId, transition.transitionId)
					.catch((failure: unknown) => recoveryFailures.push(failure));
			}
			if (active.lifecycle.status() === "destroying") {
				try {
					active.lifecycle.restoreDestroyFailure();
					await active.lifecycle.start();
				} catch (failure) {
					recoveryFailures.push(failure);
				}
			}
			throw new AggregateError(
				[cause, ...recoveryFailures],
				"Instance destroy failed and was restored when possible.",
			);
		} finally {
			lease.release();
		}
	}

	async reset(
		instanceId: InstanceId,
		options: LifecycleMutationOptions & Readonly<{ seed: boolean }>,
	): Promise<InstanceSummary> {
		const previous = this.#registry.get(instanceId);
		const lease = await previous.leases.acquireExclusive(options);
		const transition = this.#manifests.transition(instanceId, "reset");
		let replacement: ActiveInstance | undefined;
		let staged = false;
		try {
			await previous.lifecycle.stopAll();
			previous.lifecycle.beginReset();
			await this.#storage.stageInstance(instanceId, transition);
			staged = true;
			const manifest = this.#manifests.create(
				instanceId,
				previous.manifest.persistence,
				transition.transitionId,
			);
			await this.#storage.createInstance(instanceId, manifest);
			replacement = await this.#factory.start(instanceId, manifest);
			if (options.seed) await replacement.lifecycle.seed();
			await this.#writeReady(replacement);
			const summary = await summarizeInstance(replacement);
			await this.#storage.commitTransition(transition);
			try {
				await this.#finalizeCommittedReset(replacement, transition.transitionId);
			} catch (cause) {
				this.#trash.retainFailure(`reset-finalize:${transition.transitionId}`, cause);
			}
			this.#registry.replace(previous, replacement);
			previous.leases.retire();
			return summary;
		} catch (cause) {
			if (cause instanceof InstanceStagingError && cause.staged) staged = true;
			const rollbackFailures: unknown[] = [];
			if (replacement) {
				await replacement.lifecycle
					.stopAll()
					.catch((failure: unknown) => rollbackFailures.push(failure));
			}
			if (staged) {
				await this.#storage
					.discardActiveReplacement(instanceId, transition.transitionId)
					.catch((failure: unknown) => rollbackFailures.push(failure));
				await this.#storage
					.restoreStagedInstance(instanceId, transition.transitionId)
					.catch((failure: unknown) => rollbackFailures.push(failure));
				try {
					previous.lifecycle.restoreResetFailure();
					await previous.lifecycle.start();
				} catch (failure) {
					rollbackFailures.push(failure);
				}
			} else if (previous.lifecycle.status() === "resetting") {
				try {
					previous.lifecycle.restoreResetFailure();
					await previous.lifecycle.start();
				} catch (failure) {
					rollbackFailures.push(failure);
				}
			}
			throw new InstanceResetError([cause, ...rollbackFailures]);
		} finally {
			lease.release();
		}
	}

	async #createReserved(
		instanceId: InstanceId,
		options: Readonly<{ persistence: "ephemeral" | "persistent"; seed: boolean }>,
	): Promise<InstanceSummary> {
		let active: ActiveInstance | undefined;
		const trashId = this.#manifests.creationTrashId(instanceId);
		try {
			const manifest = this.#manifests.create(instanceId, options.persistence);
			await this.#storage.createInstance(instanceId, manifest);
			active = await this.#factory.start(instanceId, manifest);
			if (options.seed) await active.lifecycle.seed();
			await this.#writeReady(active);
			this.#registry.add(active);
			return await summarizeInstance(active);
		} catch (cause) {
			const cleanupFailures: unknown[] = [];
			if (active) {
				await active.lifecycle.stopAll().catch((failure: unknown) => cleanupFailures.push(failure));
			}
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

	async #writeReady(active: ActiveInstance): Promise<void> {
		const ready = this.#manifests.markReady(active.manifest);
		await this.#storage.writeInstance(active.id, ready);
		active.manifest = ready;
	}

	async #finalizeCommittedReset(active: ActiveInstance, transitionId: string): Promise<void> {
		const finalized = this.#manifests.clearTransition(active.manifest);
		await this.#storage.writeInstance(active.id, finalized);
		active.manifest = finalized;
		this.#trash.schedule(transitionId);
	}
}
