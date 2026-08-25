import type { ActiveInstance, ActiveInstanceFactory } from "./active-instance.js";
import type { ActiveInstanceRegistry } from "./active-instance-registry.js";
import { parseInstanceId } from "./identifiers.js";
import type { MonotonicClock } from "./instance-leases.js";
import type { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import { type InstanceStoragePort, StorageWriteCommittedError } from "./instance-storage.js";
import type { InstanceTrashCleanup } from "./instance-trash-cleanup.js";
import { MutationScope, MutationTimeoutError } from "./mutation-scope.js";
import { RuntimeAdmission, type RuntimeAdmissionLease } from "./runtime-admission.js";
import type { TaskScheduler } from "./task-tracker.js";

const STARTUP_TIMEOUT_MS = 30_000;

export class InstanceRuntimeClosedError extends Error {
	constructor() {
		super("The instance runtime is closing or already closed.");
		this.name = "InstanceRuntimeClosedError";
	}
}

export class InstanceRuntimeCloseTimeoutError extends Error {
	readonly activeAdmissions: number;
	override readonly cause: MutationTimeoutError;
	readonly unfinishedTaskLabels: readonly string[];

	constructor(
		cause: MutationTimeoutError,
		activeAdmissions: number,
		unfinishedTaskLabels: readonly string[],
	) {
		super(
			`Timed out closing the instance runtime with ${activeAdmissions} admitted operation${activeAdmissions === 1 ? "" : "s"} and ${unfinishedTaskLabels.length} unfinished tracked task${unfinishedTaskLabels.length === 1 ? "" : "s"}.`,
		);
		this.name = "InstanceRuntimeCloseTimeoutError";
		this.activeAdmissions = activeAdmissions;
		this.cause = cause;
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
		this.unfinishedTaskLabels = Object.freeze([...unfinishedTaskLabels]);
	}
}

export class PersistedInstanceRuntime {
	readonly #admission = new RuntimeAdmission();
	readonly #factory: ActiveInstanceFactory;
	readonly #manifests: InstanceManifestPolicy;
	readonly #monotonicClock: MonotonicClock;
	readonly #registry: ActiveInstanceRegistry;
	readonly #scheduler: TaskScheduler;
	readonly #storage: InstanceStoragePort;
	readonly #trash: InstanceTrashCleanup;
	#closePromise: Promise<void> | undefined;
	#initializePromise: Promise<void> | undefined;
	#startPromise: Promise<void> | undefined;
	#settledPromise: Promise<void> | undefined;

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

	initialize(): Promise<void> {
		this.#initializePromise ??= this.#storage.initialize();
		return this.#initializePromise;
	}

	admit(): RuntimeAdmissionLease {
		try {
			return this.#admission.admit();
		} catch {
			throw new InstanceRuntimeClosedError();
		}
	}

	assertOpen(): void {
		try {
			this.#admission.assertOpen();
		} catch {
			throw new InstanceRuntimeClosedError();
		}
	}

	startPersisted(): Promise<void> {
		this.assertOpen();
		if (this.#startPromise) return this.#startPromise;
		const admission = this.admit();
		const scope = new MutationScope(this.#monotonicClock, this.#scheduler, {
			label: "starting persisted instances",
			signals: [admission.signal],
			timeoutMs: STARTUP_TIMEOUT_MS,
		});
		const owned = this.#startPersisted(scope).finally(() => {
			scope.dispose();
			admission.release();
		});
		this.#startPromise = scope.report(owned);
		void owned.then(
			() => undefined,
			() => {
				this.#startPromise = undefined;
			},
		);
		return this.#startPromise;
	}

	async #startPersisted(scope: MutationScope): Promise<void> {
		await scope.wait(() => this.initialize());
		const recovery = await scope.wait(() => this.#storage.recover());
		for (const trashId of recovery.cleanupTrashIds) this.#trash.schedule(trashId);
		const started: ActiveInstance[] = [];
		try {
			for (const stored of await scope.wait(() => this.#storage.listInstances())) {
				scope.checkpoint();
				if (stored.persistence !== "persistent" || stored.status !== "ready") continue;
				const instanceId = parseInstanceId(stored.id);
				if (this.#registry.has(instanceId)) continue;
				const manifest = this.#manifests.repairInterruptedSeed(stored);
				if (manifest !== stored) {
					await writeInstanceManifest(this.#storage, instanceId, manifest, scope);
				}
				const active = await this.#factory.start(instanceId, manifest, {
					remainingMs: () => scope.remainingMs(),
					signal: scope.signal,
				});
				started.push(active);
				const refreshed = this.#manifests.refreshConfiguration(active.manifest);
				await writeInstanceManifest(this.#storage, instanceId, refreshed, scope);
				active.manifest = refreshed;
				this.#registry.add(active);
			}
		} catch (cause) {
			const failures: unknown[] = [cause];
			for (const active of started.reverse()) {
				active.leases.retire();
				await active.lifecycle
					.stopAll(scope.signal)
					.catch((failure: unknown) => failures.push(failure));
				const report = await active.generation.close(cause, scope.remainingMs());
				if (report.failures.length > 0 || report.unfinishedLabels.length > 0) {
					failures.push(report);
				}
				const settled = await active.generation.settled();
				if (settled.failures.length > 0 || settled.unfinishedLabels.length > 0) {
					failures.push(settled);
				}
				this.#registry.remove(active);
			}
			throw new AggregateError(failures, "Could not start persisted instances.");
		}
	}

	stopAll(timeoutMs: number): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		const scope = new MutationScope(this.#monotonicClock, this.#scheduler, {
			label: "closing the instance runtime",
			timeoutMs,
		});
		const timeoutSnapshot: RuntimeCloseTimeoutSnapshot = {
			activeAdmissions: 0,
			unfinishedTaskLabels: [],
		};
		const owned = this.#stopAll(scope, timeoutSnapshot).finally(() => scope.dispose());
		this.#settledPromise = owned;
		this.#closePromise = scope.report(owned).catch((cause: unknown) => {
			if (cause instanceof MutationTimeoutError) {
				throw new InstanceRuntimeCloseTimeoutError(
					cause,
					timeoutSnapshot.activeAdmissions,
					timeoutSnapshot.unfinishedTaskLabels,
				);
			}
			throw cause;
		});
		void owned.catch(() => undefined);
		return this.#closePromise;
	}

	settled(): Promise<void> {
		if (!this.#settledPromise) {
			throw new TypeError("Instance runtime settlement is available only after shutdown starts.");
		}
		return this.#settledPromise;
	}

	async #stopAll(
		scope: MutationScope,
		timeoutSnapshot: RuntimeCloseTimeoutSnapshot,
	): Promise<void> {
		const closing = new InstanceRuntimeClosedError();
		const failures: unknown[] = [];
		const abortRetainedWork = () => {
			const reason = scope.signal.reason ?? closing;
			timeoutSnapshot.activeAdmissions = this.#admission.activeCount();
			timeoutSnapshot.unfinishedTaskLabels = this.#registry
				.all()
				.flatMap((active) =>
					active.tasks.unfinishedLabels().map((label) => `${active.id.value}:${label}`),
				);
			this.#admission.abort(reason);
			for (const active of this.#registry.all()) active.generation.abort(reason);
		};
		scope.signal.addEventListener("abort", abortRetainedWork, { once: true });
		if (scope.signal.aborted) abortRetainedWork();
		try {
			await scope
				.wait(() => this.#admission.close())
				.catch((cause: unknown) => failures.push(cause));
			for (const active of [...this.#registry.all()].reverse()) {
				let lease: { release(): void } | undefined;
				try {
					lease = await active.leases.acquireExclusiveOwned();
					active.leases.retire();
					await active.lifecycle.stopAll(scope.signal);
				} catch (cause) {
					failures.push(cause);
					active.leases.retire();
				} finally {
					lease?.release();
				}
				const report = await active.generation.close(closing, scope.remainingMs());
				if (report.failures.length > 0 || report.unfinishedLabels.length > 0) failures.push(report);
				const settled = await active.generation.settled();
				if (settled.failures.length > 0 || settled.unfinishedLabels.length > 0) {
					failures.push(settled);
				}
			}
			const cleanup = await this.#trash.close(scope.remainingMs());
			if (cleanup.failures.length > 0 || cleanup.unfinishedLabels.length > 0) {
				failures.push(cleanup);
			}
			const settledCleanup = await this.#trash.settled();
			if (settledCleanup.failures.length > 0 || settledCleanup.unfinishedLabels.length > 0) {
				failures.push(settledCleanup);
			}
			if (scope.signal.aborted) failures.push(scope.signal.reason);
			if (failures.length > 0) {
				throw new AggregateError(failures, "Instance runtime shutdown had failures.");
			}
		} finally {
			scope.signal.removeEventListener("abort", abortRetainedWork);
		}
	}
}

interface RuntimeCloseTimeoutSnapshot {
	activeAdmissions: number;
	unfinishedTaskLabels: string[];
}

async function writeInstanceManifest(
	storage: InstanceStoragePort,
	instanceId: import("./identifiers.js").InstanceId,
	manifest: import("./manifests.js").InstanceManifest,
	scope: MutationScope,
): Promise<void> {
	scope.checkpoint();
	try {
		await storage.writeInstance(instanceId, manifest);
	} catch (cause) {
		if (!(cause instanceof StorageWriteCommittedError) || cause.operation !== "write_instance") {
			throw cause;
		}
	}
	scope.checkpoint();
}
