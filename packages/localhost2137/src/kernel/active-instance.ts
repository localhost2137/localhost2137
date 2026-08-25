import { type InstanceId, parseServiceKey } from "./identifiers.js";
import { ReadonlyInstanceClock } from "./instance-clock.js";
import { InstanceLeaseCoordinator, type MonotonicClock } from "./instance-leases.js";
import { InstanceLifecycle, type ScenarioSeedPort } from "./instance-lifecycle.js";
import type { InstanceStoragePort } from "./instance-storage.js";
import type { InstanceServiceTemplate, InstanceTemplate } from "./instance-template.js";
import type { LifecycleConfigData } from "./lifecycle-context.js";
import type { InstanceLifecycleStatus, ServiceLifecycleStatus } from "./lifecycle-state.js";
import type { InstanceManifest, InstanceSeedState, ServiceManifest } from "./manifests.js";
import { StructuredPluginLogger } from "./plugin-log-adapter.js";
import type { RuntimeTime } from "./runtime-time.js";
import { type AnyServiceLifecycle, ServiceLifecycle } from "./service-lifecycle.js";
import { reconcileServices, type ServiceReconciliationStore } from "./service-reconciliation.js";
import {
	type StructuredLogLimits,
	StructuredLogRing,
	type StructuredLogSnapshot,
} from "./structured-log.js";
import { InstanceTaskTracker, type TaskScheduler } from "./task-tracker.js";

export interface ActiveInstance {
	readonly clock: ReadonlyInstanceClock;
	readonly id: InstanceId;
	readonly leases: InstanceLeaseCoordinator;
	readonly lifecycle: InstanceLifecycle;
	readonly logs: StructuredLogRing;
	manifest: InstanceManifest;
	readonly services: readonly AnyServiceLifecycle[];
	readonly tasks: InstanceTaskTracker;
}

export interface InstanceSummary {
	readonly clock: Readonly<{ mode: "pinned" | "real"; now: string }>;
	readonly id: string;
	readonly persistence: "ephemeral" | "persistent";
	readonly seedStatus: InstanceSeedState["status"];
	readonly services: readonly Readonly<{ key: string; status: ServiceLifecycleStatus }>[];
	readonly status: InstanceLifecycleStatus;
}

export interface ActiveInstanceDependencies {
	readonly correlationId: () => string;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly logLimits: StructuredLogLimits;
	readonly monotonicClock: MonotonicClock;
	readonly scenarioSeed?: (instanceId: string) => ScenarioSeedPort | undefined;
	readonly scheduler: TaskScheduler;
	readonly storage: InstanceStoragePort;
	readonly time: RuntimeTime;
}

export class ActiveInstanceFactory {
	readonly #dependencies: ActiveInstanceDependencies;
	readonly #template: InstanceTemplate;

	constructor(template: InstanceTemplate, dependencies: ActiveInstanceDependencies) {
		this.#template = template;
		this.#dependencies = dependencies;
	}

	async start(instanceId: InstanceId, manifest: InstanceManifest): Promise<ActiveInstance> {
		const tasks = new InstanceTaskTracker(this.#dependencies.scheduler);
		const clock = new ReadonlyInstanceClock(manifest.clock, this.#dependencies.time);
		const logs = new StructuredLogRing(this.#dependencies.logLimits);
		const services = this.#template.services.map((template) =>
			this.#service(instanceId, template, clock, tasks, logs),
		);
		const holder = { manifest };
		const scenarioSeed = this.#dependencies.scenarioSeed?.(instanceId.value);
		const lifecycle = new InstanceLifecycle({
			now: () => this.#dependencies.time.nowTimestamp(),
			...(scenarioSeed ? { scenarioSeed } : {}),
			seedState: manifest.seed,
			seedStateStore: {
				write: async (seed) => {
					const next = { ...holder.manifest, seed };
					await this.#dependencies.storage.writeInstance(instanceId, next);
					holder.manifest = next;
				},
			},
			services,
			signal: new AbortController().signal,
		});
		const active: ActiveInstance = {
			clock,
			id: instanceId,
			leases: new InstanceLeaseCoordinator(
				tasks,
				this.#dependencies.scheduler,
				this.#dependencies.monotonicClock,
			),
			lifecycle,
			logs,
			get manifest() {
				return holder.manifest;
			},
			set manifest(value) {
				holder.manifest = value;
			},
			services,
			tasks,
		};
		await reconcileServices(services, this.#reconciliationStore(instanceId));
		await lifecycle.start();
		return active;
	}

	#service(
		instanceId: InstanceId,
		template: InstanceServiceTemplate,
		clock: ReadonlyInstanceClock,
		tasks: InstanceTaskTracker,
		logs: StructuredLogRing,
	): AnyServiceLifecycle {
		const serviceKey = parseServiceKey(template.serviceKey);
		return new ServiceLifecycle<unknown, LifecycleConfigData, unknown>({
			capabilities: {
				clock,
				config: template.config,
				fetch: this.#dependencies.fetch,
				instanceId: instanceId.value,
				log: new StructuredPluginLogger({
					clock,
					instanceId: instanceId.value,
					logs,
					nextCorrelationId: this.#dependencies.correlationId,
					now: () => this.#dependencies.time.nowTimestamp(),
					serviceKey: serviceKey.value,
				}),
				serviceKey: serviceKey.value,
				signal: new AbortController().signal,
				storage: this.#dependencies.storage.pluginStorage(instanceId, serviceKey),
				tasks,
			},
			...(template.configuredSeed === undefined ? {} : { configuredSeed: template.configuredSeed }),
			correlationId: this.#dependencies.correlationId,
			hooks: template.hooks,
			pluginId: template.pluginId,
			stateVersion: template.stateVersion,
		});
	}

	#reconciliationStore(instanceId: InstanceId): ServiceReconciliationStore {
		return {
			read: async (key) => {
				const serviceKey = parseServiceKey(key);
				await this.#dependencies.storage.prepareService(instanceId, serviceKey);
				return this.#dependencies.storage.readService(instanceId, serviceKey);
			},
			write: async (service, result) => {
				const serviceKey = parseServiceKey(service.serviceKey);
				const stored = await this.#dependencies.storage.readService(instanceId, serviceKey);
				const now = this.#dependencies.time.nowTimestamp();
				const manifest: ServiceManifest = {
					createdAt: stored?.createdAt ?? now,
					pluginId: service.pluginId,
					schemaVersion: 1,
					serviceKey: service.serviceKey,
					stateVersion: result.stateVersion,
					updatedAt: now,
				};
				await this.#dependencies.storage.writeService(instanceId, serviceKey, manifest);
			},
		};
	}
}

export async function summarizeInstance(active: ActiveInstance): Promise<InstanceSummary> {
	return Object.freeze({
		clock: await active.clock.status(),
		id: active.id.value,
		persistence: active.manifest.persistence,
		seedStatus: active.lifecycle.seedStatus(),
		services: Object.freeze(
			active.services.map((service) =>
				Object.freeze({ key: service.serviceKey, status: service.status() }),
			),
		),
		status: active.lifecycle.status(),
	});
}

export function instanceLogs(active: ActiveInstance): StructuredLogSnapshot {
	return active.logs.snapshot();
}
