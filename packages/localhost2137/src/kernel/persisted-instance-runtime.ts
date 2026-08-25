import type { ActiveInstance, ActiveInstanceFactory } from "./active-instance.js";
import type { ActiveInstanceRegistry } from "./active-instance-registry.js";
import { parseInstanceId } from "./identifiers.js";
import type { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import type { InstanceStoragePort } from "./instance-storage.js";
import type { InstanceTrashCleanup } from "./instance-trash-cleanup.js";

export class InstanceRuntimeClosedError extends Error {
	constructor() {
		super("The instance runtime is closing or already closed.");
		this.name = "InstanceRuntimeClosedError";
	}
}

export class PersistedInstanceRuntime {
	readonly #factory: ActiveInstanceFactory;
	readonly #manifests: InstanceManifestPolicy;
	readonly #registry: ActiveInstanceRegistry;
	readonly #storage: InstanceStoragePort;
	readonly #trash: InstanceTrashCleanup;
	#closePromise: Promise<void> | undefined;
	#initializePromise: Promise<void> | undefined;
	#startPromise: Promise<void> | undefined;

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

	initialize(): Promise<void> {
		this.assertOpen();
		this.#initializePromise ??= this.#storage.initialize();
		return this.#initializePromise;
	}

	assertOpen(): void {
		if (this.#closePromise) throw new InstanceRuntimeClosedError();
	}

	startPersisted(): Promise<void> {
		this.assertOpen();
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#startPersisted().catch((cause: unknown) => {
			this.#startPromise = undefined;
			throw cause;
		});
		return this.#startPromise;
	}

	async #startPersisted(): Promise<void> {
		await this.initialize();
		const recovery = await this.#storage.recover();
		for (const trashId of recovery.cleanupTrashIds) this.#trash.schedule(trashId);
		const started: ActiveInstance[] = [];
		try {
			for (const stored of await this.#storage.listInstances()) {
				if (stored.persistence !== "persistent" || stored.status !== "ready") continue;
				const instanceId = parseInstanceId(stored.id);
				if (this.#registry.has(instanceId)) continue;
				const manifest = this.#manifests.repairInterruptedSeed(stored);
				if (manifest !== stored) await this.#storage.writeInstance(instanceId, manifest);
				const active = await this.#factory.start(instanceId, manifest);
				started.push(active);
				const refreshed = this.#manifests.refreshConfiguration(active.manifest);
				await this.#storage.writeInstance(instanceId, refreshed);
				active.manifest = refreshed;
				this.#registry.add(active);
			}
		} catch (cause) {
			const failures: unknown[] = [cause];
			for (const active of started.reverse()) {
				await active.lifecycle.stopAll().catch((failure: unknown) => failures.push(failure));
				this.#registry.remove(active);
			}
			throw new AggregateError(failures, "Could not start persisted instances.");
		}
	}

	stopAll(timeoutMs: number): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#stopAll(timeoutMs);
		return this.#closePromise;
	}

	async #stopAll(timeoutMs: number): Promise<void> {
		const failures: unknown[] = [];
		for (const active of [...this.#registry.all()].reverse()) {
			try {
				const lease = await active.leases.acquireExclusive({ timeoutMs });
				try {
					active.leases.retire();
					await active.lifecycle.stopAll();
				} finally {
					lease.release();
				}
				const report = await active.tasks.close({ graceMs: timeoutMs });
				if (report.failures.length > 0 || report.unfinishedLabels.length > 0) failures.push(report);
			} catch (cause) {
				failures.push(cause);
			}
		}
		const cleanup = await this.#trash.close(timeoutMs);
		if (cleanup.failures.length > 0 || cleanup.unfinishedLabels.length > 0) failures.push(cleanup);
		if (failures.length > 0) {
			throw new AggregateError(failures, "Instance runtime shutdown had failures.");
		}
	}
}
