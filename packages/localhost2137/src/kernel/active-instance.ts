import { ActiveInstanceGeneration } from "./active-instance-generation.js";
import { retireActiveInstance } from "./active-instance-retirement.js";
import { type InstanceId, parseServiceKey } from "./identifiers.js";
import { InstanceClock } from "./instance-clock.js";
import { InstanceLeaseCoordinator, type MonotonicClock } from "./instance-leases.js";
import { InstanceLifecycle, type ScenarioSeedPort } from "./instance-lifecycle.js";
import {
	type InstanceStoragePort,
	StorageWriteCommittedError,
	type StorageWriteOperation,
} from "./instance-storage.js";
import type { InstanceServiceTemplate, InstanceTemplate } from "./instance-template.js";
import type { LifecycleConfigData } from "./lifecycle-context.js";
import { LifecycleHookRunner } from "./lifecycle-hook-runner.js";
import type { InstanceLifecycleStatus, ServiceLifecycleStatus } from "./lifecycle-state.js";
import type {
	InstanceManifest,
	InstanceSeedState,
	ServiceManifest,
	StorageTransitionManifest,
} from "./manifests.js";
import { ownInstanceManifest } from "./manifests.js";
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
import { TrackedPluginFetch } from "./tracked-plugin-fetch.js";
import { DurableTimeAdvancement } from "./durable-time-advancement.js";

export interface ActiveInstance {
	readonly clock: InstanceClock;
	readonly generation: ActiveInstanceGeneration;
	readonly id: InstanceId;
	readonly leases: InstanceLeaseCoordinator;
	readonly lifecycle: InstanceLifecycle;
	readonly logs: StructuredLogRing;
	manifest: InstanceManifest;
	pendingResetTransition?: StorageTransitionManifest;
	readonly services: readonly AnyServiceLifecycle[];
	readonly tasks: InstanceTaskTracker;
	readonly timeAdvancement: DurableTimeAdvancement;
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
	readonly advanceId: () => string;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly logLimits: StructuredLogLimits;
	readonly monotonicClock: MonotonicClock;
	readonly scenarioSeed?: (input: ScenarioSeedFactoryInput) => ScenarioSeedPort | undefined;
	readonly scheduler: TaskScheduler;
	readonly storage: InstanceStoragePort;
	readonly time: RuntimeTime;
}

export interface ScenarioSeedFactoryInput {
	readonly instanceId: string;
	readonly logs: StructuredLogRing;
	readonly services: readonly AnyServiceLifecycle[];
}

export class ActiveInstanceFactory {
	readonly #dependencies: ActiveInstanceDependencies;
	readonly #template: InstanceTemplate;

	constructor(template: InstanceTemplate, dependencies: ActiveInstanceDependencies) {
		this.#template = template;
		this.#dependencies = dependencies;
	}

	async start(
		instanceId: InstanceId,
		manifest: InstanceManifest,
		options: Readonly<{ remainingMs: () => number; signal: AbortSignal }>,
	): Promise<ActiveInstance> {
		const tasks = new InstanceTaskTracker(this.#dependencies.scheduler);
		const generation = new ActiveInstanceGeneration(tasks);
		const hooks = new LifecycleHookRunner(tasks, generation.signal);
		const signal = AbortSignal.any([generation.signal, options.signal]);
		const clock = new InstanceClock(manifest.clock, this.#dependencies.time);
		const logs = new StructuredLogRing(this.#dependencies.logLimits);
		const services = this.#template.services.map((template) =>
			this.#service(instanceId, template, clock, tasks, logs, generation.signal, hooks),
		);
		const holder = { manifest };
		const scenarioSeed = this.#dependencies.scenarioSeed?.({
			instanceId: instanceId.value,
			logs,
			services,
		});
		const lifecycle = new InstanceLifecycle({
			hooks,
			now: () => this.#dependencies.time.nowTimestamp(),
			...(scenarioSeed ? { scenarioSeed } : {}),
			seedState: manifest.seed,
			seedStateStore: {
				write: async (seed) => {
					const next = ownInstanceManifest({ ...holder.manifest, seed });
					try {
						await this.#dependencies.storage.writeInstance(instanceId, next);
					} catch (cause) {
						if (!isCommittedStorageWrite(cause, "write_instance")) throw cause;
						holder.manifest = next;
						return Object.freeze({ committedWarning: cause });
					}
					holder.manifest = next;
					return undefined;
				},
			},
			services,
			signal: generation.signal,
		});
		const timeAdvancement = new DurableTimeAdvancement({
			clock,
			getManifest: () => holder.manifest,
			instanceId,
			services,
			setManifest: (next) => {
				holder.manifest = next;
			},
			storage: this.#dependencies.storage,
			tasks: {
				failureCheckpoint: () => tasks.failureCheckpoint(),
				idleSince: (checkpoint, phaseSignal) =>
					tasks.idleSince(checkpoint, {
						...(phaseSignal ? { signal: phaseSignal } : {}),
						timeoutMs: options.remainingMs(),
					}),
			},
			token: this.#dependencies.advanceId,
		});
		const active: ActiveInstance = {
			clock,
			generation,
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
			timeAdvancement,
		};
		try {
			await reconcileServices(services, this.#reconciliationStore(instanceId), signal);
			await lifecycle.start(signal);
			await timeAdvancement.recover(signal);
			await tasks.idle({ signal, timeoutMs: options.remainingMs() });
			return active;
		} catch (cause) {
			const cleanupFailures: unknown[] = [];
			const retirement = retireActiveInstance(active, {
				remainingMs: options.remainingMs,
				reason: cause,
				signal,
			});
			const report = await retirement.settled;
			cleanupFailures.push(...report.blockingFailures);
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[cause, ...cleanupFailures],
					`Starting instance "${instanceId.value}" failed during cleanup.`,
				);
			}
			throw cause;
		}
	}

	#service(
		instanceId: InstanceId,
		template: InstanceServiceTemplate,
		clock: InstanceClock,
		tasks: InstanceTaskTracker,
		logs: StructuredLogRing,
		generationSignal: AbortSignal,
		hookRunner: LifecycleHookRunner,
	): AnyServiceLifecycle {
		const serviceKey = parseServiceKey(template.serviceKey);
		const trackedFetch = new TrackedPluginFetch({
			clock,
			correlationId: this.#dependencies.correlationId,
			fetch: this.#dependencies.fetch,
			instanceId: instanceId.value,
			logs,
			monotonicClock: this.#dependencies.monotonicClock,
			serviceKey: serviceKey.value,
			tasks,
			time: this.#dependencies.time,
		});
		return new ServiceLifecycle<unknown, LifecycleConfigData, unknown>({
			capabilities: {
				clock,
				config: template.config,
				fetch: trackedFetch.fetch,
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
				signal: generationSignal,
				storage: this.#dependencies.storage.pluginStorage(instanceId, serviceKey),
				tasks,
			},
			...(template.configuredSeed === undefined ? {} : { configuredSeed: template.configuredSeed }),
			correlationId: this.#dependencies.correlationId,
			hookRunner,
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

function isCommittedStorageWrite(cause: unknown, operation: StorageWriteOperation): boolean {
	return cause instanceof StorageWriteCommittedError && cause.operation === operation;
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
