import type { RunningPluginContext } from "../authoring/context.js";
import {
	type ActiveInstanceDependencies,
	ActiveInstanceFactory,
	type InstanceSummary,
	instanceLogs,
	summarizeInstance,
} from "./active-instance.js";
import { ActiveInstanceRegistry } from "./active-instance-registry.js";
import {
	DurableInstanceMutations,
	type LifecycleMutationOptions,
	type OwnedMutation,
} from "./durable-instance-mutations.js";
import { parseInstanceId, parseServiceKey } from "./identifiers.js";
import type { InstanceLease } from "./instance-leases.js";
import { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import type { InstanceTemplate } from "./instance-template.js";
import { InstanceTrashCleanup } from "./instance-trash-cleanup.js";
import { PersistedInstanceRuntime } from "./persisted-instance-runtime.js";
import type { AnyServiceLifecycle } from "./service-lifecycle.js";
import type { StructuredLogRing, StructuredLogSnapshot } from "./structured-log.js";

export interface InstanceManagerDependencies extends ActiveInstanceDependencies {
	readonly token: () => string;
}

export interface RunningServiceLease {
	readonly context: RunningPluginContext<unknown, unknown>;
	readonly logs: StructuredLogRing;
	release(): void;
}

class ServiceNotFoundError extends Error {
	constructor(instanceId: string, serviceKey: string) {
		super(`Service "${serviceKey}" is not configured for instance "${instanceId}".`);
		this.name = "ServiceNotFoundError";
	}
}

export class InstanceManager {
	readonly #mutations: DurableInstanceMutations;
	readonly #registry: ActiveInstanceRegistry;
	readonly #runtime: PersistedInstanceRuntime;

	constructor(template: InstanceTemplate, dependencies: InstanceManagerDependencies) {
		this.#registry = new ActiveInstanceRegistry();
		const factory = new ActiveInstanceFactory(template, dependencies);
		const manifests = new InstanceManifestPolicy(template, dependencies.time, dependencies.token);
		const trash = new InstanceTrashCleanup(dependencies.storage, dependencies.scheduler);
		this.#mutations = new DurableInstanceMutations({
			factory,
			manifests,
			monotonicClock: dependencies.monotonicClock,
			registry: this.#registry,
			scheduler: dependencies.scheduler,
			storage: dependencies.storage,
			trash,
		});
		this.#runtime = new PersistedInstanceRuntime({
			factory,
			manifests,
			monotonicClock: dependencies.monotonicClock,
			registry: this.#registry,
			scheduler: dependencies.scheduler,
			storage: dependencies.storage,
			trash,
		});
	}

	async create(
		options: Readonly<{
			id: string;
			persistence: "ephemeral" | "persistent";
			seed: boolean;
			signal?: AbortSignal;
			timeoutMs?: number;
		}>,
	): Promise<InstanceSummary> {
		const instanceId = parseInstanceId(options.id);
		return this.#runMutation((runtimeSignal) =>
			this.#mutations.create(instanceId, {
				...options,
				runtimeSignal,
			}),
		);
	}

	async list(): Promise<readonly InstanceSummary[]> {
		this.#runtime.assertOpen();
		return Object.freeze(await Promise.all(this.#registry.all().map(summarizeInstance)));
	}

	async get(id: string): Promise<InstanceSummary> {
		this.#runtime.assertOpen();
		return await summarizeInstance(this.#registry.get(parseInstanceId(id)));
	}

	logs(id: string): StructuredLogSnapshot {
		this.#runtime.assertOpen();
		return instanceLogs(this.#registry.get(parseInstanceId(id)));
	}

	async acquireShared(id: string, signal?: AbortSignal): Promise<InstanceLease> {
		const admission = this.#runtime.admit();
		try {
			const lease = await this.#registry
				.get(parseInstanceId(id))
				.leases.acquireShared(
					signal ? AbortSignal.any([signal, admission.signal]) : admission.signal,
				);
			let released = false;
			return Object.freeze({
				release: () => {
					if (released) return;
					released = true;
					lease.release();
					admission.release();
				},
			});
		} catch (cause) {
			admission.release();
			throw cause;
		}
	}

	async acquireService(
		id: string,
		key: string,
		signal?: AbortSignal,
	): Promise<RunningServiceLease> {
		const admission = this.#runtime.admit();
		try {
			const instanceId = parseInstanceId(id);
			const serviceKey = parseServiceKey(key);
			const active = this.#registry.get(instanceId);
			const service = active.services.find(
				(candidate) => candidate.serviceKey === serviceKey.value,
			);
			if (!service) throw new ServiceNotFoundError(instanceId.value, serviceKey.value);
			const operationSignal = signal
				? AbortSignal.any([signal, admission.signal])
				: admission.signal;
			const lease = await active.leases.acquireShared(operationSignal);
			let released = false;
			return Object.freeze({
				context: service.runningContext(operationSignal),
				logs: active.logs,
				release: () => {
					if (released) return;
					released = true;
					lease.release();
					admission.release();
				},
			});
		} catch (cause) {
			admission.release();
			throw cause;
		}
	}

	service(id: string, key: string): AnyServiceLifecycle {
		this.#runtime.assertOpen();
		const instanceId = parseInstanceId(id);
		const serviceKey = parseServiceKey(key);
		const active = this.#registry.get(instanceId);
		const service = active.services.find((candidate) => candidate.serviceKey === serviceKey.value);
		if (!service) throw new ServiceNotFoundError(instanceId.value, serviceKey.value);
		return service;
	}

	async seed(id: string, options: LifecycleMutationOptions): Promise<void> {
		return this.#runMutation((runtimeSignal) =>
			this.#mutations.seed(parseInstanceId(id), {
				...options,
				runtimeSignal,
			}),
		);
	}

	async destroy(id: string, options: LifecycleMutationOptions): Promise<void> {
		return this.#runMutation((runtimeSignal) =>
			this.#mutations.destroy(parseInstanceId(id), {
				...options,
				runtimeSignal,
			}),
		);
	}

	async reset(
		id: string,
		options: LifecycleMutationOptions & Readonly<{ seed: boolean }>,
	): Promise<InstanceSummary> {
		return this.#runMutation((runtimeSignal) =>
			this.#mutations.reset(parseInstanceId(id), {
				...options,
				runtimeSignal,
			}),
		);
	}

	startPersisted(): Promise<void> {
		return this.#runtime.startPersisted();
	}

	stopAll(options: Readonly<{ timeoutMs: number }>): Promise<void> {
		return this.#runtime.stopAll(options.timeoutMs);
	}

	#runMutation<Value>(start: (runtimeSignal: AbortSignal) => OwnedMutation<Value>): Promise<Value> {
		const admission = this.#runtime.admit();
		try {
			const operation = start(admission.signal);
			void operation.settled.then(() => admission.release());
			return operation.result;
		} catch (cause) {
			admission.release();
			throw cause;
		}
	}
}

export type { InstanceSummary } from "./active-instance.js";
export {
	InstanceAlreadyExistsError,
	InstanceNotFoundError,
} from "./active-instance-registry.js";
export {
	InstanceCreationError,
	InstanceMutationCommittedError,
	InstanceResetError,
} from "./durable-instance-mutations.js";
