import type { BasePluginContext, RunningPluginContext } from "../authoring/context.js";
import {
	createBasePluginContext,
	createRunningPluginContext,
	type LifecycleContextCapabilities,
} from "./lifecycle-context.js";
import { ServiceLifecycleStateOwner, type ServiceLifecycleStatus } from "./lifecycle-state.js";

export interface ServiceLifecycleHooks<State, Config, Seed> {
	readonly create: (context: BasePluginContext<Config>) => Promise<void> | void;
	readonly seed?: (
		context: RunningPluginContext<State, Config>,
		seed: Seed,
	) => Promise<void> | void;
	readonly start: (context: BasePluginContext<Config>) => Promise<State> | State;
	readonly stop?: (context: RunningPluginContext<State, Config>) => Promise<void> | void;
	readonly update?: (
		context: BasePluginContext<Config>,
		version: Readonly<{ from: number; to: number }>,
	) => Promise<void> | void;
}

export interface StoredServiceIdentity {
	readonly pluginId: string;
	readonly stateVersion: number;
}

export type ServiceReconciliation =
	| Readonly<{ kind: "created"; stateVersion: number }>
	| Readonly<{ from: number; kind: "updated"; stateVersion: number }>
	| Readonly<{ kind: "unchanged"; stateVersion: number }>;

export class LifecycleHookError extends Error {
	readonly correlationId: string;
	readonly hook: "create" | "seed" | "start" | "stop" | "update";
	readonly instanceId: string;
	readonly serviceKey: string;

	constructor(
		context: Readonly<{
			correlationId: string;
			hook: "create" | "seed" | "start" | "stop" | "update";
			instanceId: string;
			serviceKey: string;
		}>,
		cause: unknown,
	) {
		super(
			`Lifecycle ${context.hook} failed for service "${context.serviceKey}" in instance "${context.instanceId}" (correlation ${context.correlationId}).`,
			{ cause },
		);
		this.name = "LifecycleHookError";
		this.correlationId = context.correlationId;
		this.hook = context.hook;
		this.instanceId = context.instanceId;
		this.serviceKey = context.serviceKey;
	}
}

export class ServiceIdentityConflictError extends Error {
	readonly configuredPluginId: string;
	readonly serviceKey: string;
	readonly storedPluginId: string;

	constructor(serviceKey: string, storedPluginId: string, configuredPluginId: string) {
		super(
			`Service "${serviceKey}" stores plugin "${storedPluginId}" but config now uses "${configuredPluginId}"; reset the instance explicitly.`,
		);
		this.name = "ServiceIdentityConflictError";
		this.serviceKey = serviceKey;
		this.storedPluginId = storedPluginId;
		this.configuredPluginId = configuredPluginId;
	}
}

export class ServiceStateDowngradeError extends Error {
	readonly configuredVersion: number;
	readonly serviceKey: string;
	readonly storedVersion: number;

	constructor(serviceKey: string, storedVersion: number, configuredVersion: number) {
		super(
			`Service "${serviceKey}" state version ${storedVersion} is newer than supported version ${configuredVersion}.`,
		);
		this.name = "ServiceStateDowngradeError";
		this.serviceKey = serviceKey;
		this.storedVersion = storedVersion;
		this.configuredVersion = configuredVersion;
	}
}

export class ServiceUpdateRequiredError extends Error {
	constructor(serviceKey: string, from: number, to: number) {
		super(
			`Service "${serviceKey}" must update state from ${from} to ${to}, but the plugin has no lifecycle.update hook; reset the instance explicitly.`,
		);
		this.name = "ServiceUpdateRequiredError";
	}
}

export class ServiceSeedContractError extends Error {
	constructor(serviceKey: string) {
		super(`Service "${serviceKey}" has configured seed data but no lifecycle.seed hook.`);
		this.name = "ServiceSeedContractError";
	}
}

export class ServiceLifecycle<State, Config, Seed> {
	readonly #capabilities: LifecycleContextCapabilities<Config>;
	readonly #configuredSeed: Seed | undefined;
	readonly #correlationId: () => string;
	readonly #hooks: ServiceLifecycleHooks<State, Config, Seed>;
	readonly #pluginId: string;
	readonly #state = new ServiceLifecycleStateOwner<State>();
	readonly #stateVersion: number;

	constructor(input: {
		readonly capabilities: LifecycleContextCapabilities<Config>;
		readonly configuredSeed?: Seed;
		readonly correlationId: () => string;
		readonly hooks: ServiceLifecycleHooks<State, Config, Seed>;
		readonly pluginId: string;
		readonly stateVersion: number;
	}) {
		this.#capabilities = input.capabilities;
		this.#configuredSeed = input.configuredSeed;
		this.#correlationId = input.correlationId;
		this.#hooks = input.hooks;
		this.#pluginId = input.pluginId;
		this.#stateVersion = input.stateVersion;
	}

	get pluginId(): string {
		return this.#pluginId;
	}

	get serviceKey(): string {
		return this.#capabilities.serviceKey;
	}

	get stateVersion(): number {
		return this.#stateVersion;
	}

	status(): ServiceLifecycleStatus {
		return this.#state.status();
	}

	async reconcile(
		stored?: StoredServiceIdentity,
		signal?: AbortSignal,
	): Promise<ServiceReconciliation> {
		const capabilities = this.#phaseCapabilities(signal);
		if (!stored) {
			this.#state.beginCreate();
			try {
				await this.#hooks.create(createBasePluginContext(capabilities));
				this.#state.createSucceeded();
				return Object.freeze({ kind: "created", stateVersion: this.#stateVersion });
			} catch (cause) {
				this.#state.createFailed();
				throw this.#hookError("create", cause);
			}
		}

		if (stored.pluginId !== this.#pluginId) {
			throw new ServiceIdentityConflictError(this.serviceKey, stored.pluginId, this.#pluginId);
		}
		if (stored.stateVersion > this.#stateVersion) {
			throw new ServiceStateDowngradeError(
				this.serviceKey,
				stored.stateVersion,
				this.#stateVersion,
			);
		}
		this.#state.restoreStopped();
		if (stored.stateVersion === this.#stateVersion) {
			return Object.freeze({ kind: "unchanged", stateVersion: this.#stateVersion });
		}
		if (!this.#hooks.update) {
			throw new ServiceUpdateRequiredError(
				this.serviceKey,
				stored.stateVersion,
				this.#stateVersion,
			);
		}

		this.#state.beginUpdate();
		try {
			await this.#hooks.update(createBasePluginContext(capabilities), {
				from: stored.stateVersion,
				to: this.#stateVersion,
			});
			this.#state.updateFinished();
			return Object.freeze({
				from: stored.stateVersion,
				kind: "updated",
				stateVersion: this.#stateVersion,
			});
		} catch (cause) {
			this.#state.updateFinished();
			throw this.#hookError("update", cause);
		}
	}

	async start(signal?: AbortSignal): Promise<void> {
		this.#state.beginStart();
		try {
			const state = await this.#hooks.start(
				createBasePluginContext(this.#phaseCapabilities(signal)),
			);
			this.#state.startSucceeded(state);
		} catch (cause) {
			this.#state.startFailed();
			throw this.#hookError("start", cause);
		}
	}

	async seed(signal?: AbortSignal): Promise<void> {
		if (this.#configuredSeed === undefined) return;
		const hook = this.#hooks.seed;
		if (!hook) {
			throw new ServiceSeedContractError(this.serviceKey);
		}
		const state = this.#state.beginSeed();
		try {
			await hook(
				createRunningPluginContext(this.#phaseCapabilities(signal), state),
				this.#configuredSeed,
			);
		} catch (cause) {
			throw this.#hookError("seed", cause);
		} finally {
			this.#state.seedFinished();
		}
	}

	async stop(signal?: AbortSignal): Promise<void> {
		const state = this.#state.beginStop();
		try {
			await this.#hooks.stop?.(createRunningPluginContext(this.#phaseCapabilities(signal), state));
			this.#state.stopFinished(true);
		} catch (cause) {
			this.#state.stopFinished(false);
			throw this.#hookError("stop", cause);
		}
	}

	runningContext(signal?: AbortSignal): RunningPluginContext<State, Config> {
		return createRunningPluginContext(this.#phaseCapabilities(signal), this.#state.runningState());
	}

	#phaseCapabilities(signal?: AbortSignal): LifecycleContextCapabilities<Config> {
		if (!signal || signal === this.#capabilities.signal) return this.#capabilities;
		return Object.freeze({
			...this.#capabilities,
			signal: AbortSignal.any([this.#capabilities.signal, signal]),
		});
	}

	#hookError(
		hook: "create" | "seed" | "start" | "stop" | "update",
		cause: unknown,
	): LifecycleHookError {
		return new LifecycleHookError(
			{
				correlationId: this.#correlationId(),
				hook,
				instanceId: this.#capabilities.instanceId,
				serviceKey: this.serviceKey,
			},
			cause,
		);
	}
}

export interface AnyServiceLifecycle {
	readonly pluginId: string;
	readonly serviceKey: string;
	readonly stateVersion: number;
	reconcile(stored?: StoredServiceIdentity, signal?: AbortSignal): Promise<ServiceReconciliation>;
	runningContext(signal?: AbortSignal): RunningPluginContext<unknown, unknown>;
	seed(signal?: AbortSignal): Promise<void>;
	start(signal?: AbortSignal): Promise<void>;
	status(): ServiceLifecycleStatus;
	stop(signal?: AbortSignal): Promise<void>;
}
