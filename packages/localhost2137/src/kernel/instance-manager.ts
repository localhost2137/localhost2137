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
} from "./durable-instance-mutations.js";
import { parseInstanceId, parseServiceKey } from "./identifiers.js";
import type { InstanceLease } from "./instance-leases.js";
import { InstanceManifestPolicy } from "./instance-manifest-policy.js";
import type { InstanceTemplate } from "./instance-template.js";
import { InstanceTrashCleanup } from "./instance-trash-cleanup.js";
import { PersistedInstanceRuntime } from "./persisted-instance-runtime.js";
import type { AnyServiceLifecycle } from "./service-lifecycle.js";
import type { StructuredLogSnapshot } from "./structured-log.js";

export interface InstanceManagerDependencies extends ActiveInstanceDependencies {
	readonly token: () => string;
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
			registry: this.#registry,
			storage: dependencies.storage,
			trash,
		});
		this.#runtime = new PersistedInstanceRuntime({
			factory,
			manifests,
			registry: this.#registry,
			storage: dependencies.storage,
			trash,
		});
	}

	async create(
		options: Readonly<{ id: string; persistence: "ephemeral" | "persistent"; seed: boolean }>,
	): Promise<InstanceSummary> {
		const instanceId = parseInstanceId(options.id);
		await this.#runtime.initialize();
		return this.#mutations.create(instanceId, options);
	}

	async list(): Promise<readonly InstanceSummary[]> {
		return Object.freeze(await Promise.all(this.#registry.all().map(summarizeInstance)));
	}

	async get(id: string): Promise<InstanceSummary> {
		return await summarizeInstance(this.#registry.get(parseInstanceId(id)));
	}

	logs(id: string): StructuredLogSnapshot {
		return instanceLogs(this.#registry.get(parseInstanceId(id)));
	}

	async acquireShared(id: string, signal?: AbortSignal): Promise<InstanceLease> {
		this.#runtime.assertOpen();
		return await this.#registry.get(parseInstanceId(id)).leases.acquireShared(signal);
	}

	service(id: string, key: string): AnyServiceLifecycle {
		const instanceId = parseInstanceId(id);
		const serviceKey = parseServiceKey(key);
		const active = this.#registry.get(instanceId);
		const service = active.services.find((candidate) => candidate.serviceKey === serviceKey.value);
		if (!service) throw new ServiceNotFoundError(instanceId.value, serviceKey.value);
		return service;
	}

	async seed(id: string, options: LifecycleMutationOptions): Promise<void> {
		this.#runtime.assertOpen();
		const active = this.#registry.get(parseInstanceId(id));
		const lease = await active.leases.acquireExclusive(options);
		try {
			await active.lifecycle.seed();
		} finally {
			lease.release();
		}
	}

	async destroy(id: string, options: LifecycleMutationOptions): Promise<void> {
		this.#runtime.assertOpen();
		await this.#mutations.destroy(parseInstanceId(id), options);
	}

	async reset(
		id: string,
		options: LifecycleMutationOptions & Readonly<{ seed: boolean }>,
	): Promise<InstanceSummary> {
		this.#runtime.assertOpen();
		return await this.#mutations.reset(parseInstanceId(id), options);
	}

	startPersisted(): Promise<void> {
		return this.#runtime.startPersisted();
	}

	stopAll(options: Readonly<{ timeoutMs: number }>): Promise<void> {
		return this.#runtime.stopAll(options.timeoutMs);
	}
}

export type { InstanceSummary } from "./active-instance.js";
export {
	InstanceAlreadyExistsError,
	InstanceNotFoundError,
} from "./active-instance-registry.js";
export { InstanceCreationError, InstanceResetError } from "./durable-instance-mutations.js";
