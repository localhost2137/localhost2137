import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { InstanceHandle, RuntimeConfig, ServiceRecord } from "../authoring/config.js";
import { type ResolvedConfig, resolveConfig } from "../config/config-resolution.js";
import { type ControlClient, connectRuntime } from "../control/control-client.js";
import { NodeInstanceStorage } from "../node/instance-storage.js";
import { nodeMonotonicClock } from "../node/monotonic-clock.js";
import { createProjectRuntime, type ProjectRuntimeComposition } from "../node/project-runtime.js";
import { NodeRuntimeTime } from "../node/runtime-time.js";
import { nodeTaskScheduler } from "../node/task-scheduler.js";
import { TemporaryRuntimeStorage } from "./temporary-runtime-storage.js";
import { createTestInstanceHandle, type TestRuntimeGate } from "./test-instance-handle.js";
import { TestRuntimeCleanupError, TestRuntimeClosedError } from "./test-runtime-errors.js";

const TEST_LOG_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxEntries: 1_000 });
const CLOSE_TIMEOUT_MS = 30_000;

export interface CreateTestRuntimeOptions<Services extends ServiceRecord> {
	readonly config: RuntimeConfig<Services>;
	readonly port: 0;
	readonly storage: "temporary";
}

export interface TestRuntime<Services extends ServiceRecord> {
	readonly url: string;
	close(): Promise<void>;
	createInstance(options?: Readonly<{ seed?: boolean }>): Promise<InstanceHandle<Services>>;
}

interface TestRuntimeDependencies {
	readonly createStorage: () => Promise<TemporaryRuntimeStorage>;
	readonly correlationId: () => string;
	readonly fetch: typeof globalThis.fetch;
	readonly token: () => string;
}

/** Starts one explicitly-owned loopback runtime backed by temporary storage. */
export function createTestRuntime<const Services extends ServiceRecord>(
	options: CreateTestRuntimeOptions<Services>,
): Promise<TestRuntime<Services>> {
	return createTestRuntimeWithDependencies(options, defaultDependencies());
}

export async function createTestRuntimeWithDependencies<Services extends ServiceRecord>(
	options: CreateTestRuntimeOptions<Services>,
	dependencies: TestRuntimeDependencies,
): Promise<TestRuntime<Services>> {
	const config = validateOptions(options);
	const storage = await dependencies.createStorage();
	let composition: ProjectRuntimeComposition | undefined;
	try {
		const controlToken = dependencies.token();
		composition = createProjectRuntime(config, {
			controlToken,
			correlationId: dependencies.correlationId,
			fetch: dependencies.fetch,
			logLimits: TEST_LOG_LIMITS,
			monotonicClock: nodeMonotonicClock,
			scheduler: nodeTaskScheduler,
			storage: new NodeInstanceStorage(storage.path),
			time: new NodeRuntimeTime(),
			token: dependencies.token,
		});
		const address = await composition.server.start({ host: "127.0.0.1", port: 0 });
		const client = connectRuntime({ token: controlToken, url: address.url });
		return new TestRuntimeOwner<Services>(
			config,
			composition,
			client,
			storage,
			address.url,
		).facade();
	} catch (cause) {
		const failures: unknown[] = [cause];
		if (composition) {
			await composition.server
				.close(CLOSE_TIMEOUT_MS)
				.catch((failure: unknown) => failures.push(failure));
		}
		await storage.remove().catch((failure: unknown) => failures.push(failure));
		if (failures.length === 1) throw cause;
		throw new TestRuntimeCleanupError(storage.path, failures);
	}
}

class TestRuntimeOwner<Services extends ServiceRecord> implements TestRuntimeGate {
	readonly #client: ControlClient;
	#closePromise: Promise<void> | undefined;
	readonly #composition: ProjectRuntimeComposition;
	readonly #config: ResolvedConfig;
	#phase: "closed" | "closing" | "open" = "open";
	readonly #storage: TemporaryRuntimeStorage;
	readonly #url: string;

	constructor(
		config: ResolvedConfig,
		composition: ProjectRuntimeComposition,
		client: ControlClient,
		storage: TemporaryRuntimeStorage,
		url: string,
	) {
		this.#client = client;
		this.#composition = composition;
		this.#config = config;
		this.#storage = storage;
		this.#url = url;
	}

	assertOpen(): void {
		if (this.#phase !== "open") throw new TestRuntimeClosedError();
	}

	facade(): TestRuntime<Services> {
		return Object.freeze({
			close: () => this.close(),
			createInstance: (options?: Readonly<{ seed?: boolean }>) => this.createInstance(options),
			url: this.#url,
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#phase = "closing";
		this.#closePromise = this.#closeOwned();
		return this.#closePromise;
	}

	async createInstance(
		options: Readonly<{ seed?: boolean }> = {},
	): Promise<InstanceHandle<Services>> {
		const owned = ownCreateInstanceOptions(options);
		this.assertOpen();
		const instanceId = createTestInstanceId();
		try {
			await this.#client.createInstance({
				id: instanceId,
				persistence: "ephemeral",
				seed: owned.seed,
			});
		} catch (cause) {
			if (this.#phase !== "open") throw new TestRuntimeClosedError();
			throw cause;
		}
		if (this.#phase !== "open") throw new TestRuntimeClosedError();
		try {
			return createTestInstanceHandle<Services>({
				client: this.#client,
				config: this.#config,
				instanceId,
				runtime: this,
				url: this.#url,
			});
		} catch (cause) {
			const failures: unknown[] = [cause];
			await this.#client
				.destroyInstance(instanceId)
				.catch((failure: unknown) => failures.push(failure));
			if (failures.length === 1) throw cause;
			throw new AggregateError(
				failures,
				`Test instance "${instanceId}" creation failed and cleanup was incomplete.`,
			);
		}
	}

	async #closeOwned(): Promise<void> {
		const failures: unknown[] = [];
		await this.#composition.server
			.close(CLOSE_TIMEOUT_MS)
			.catch((cause: unknown) => failures.push(cause));
		await this.#composition.server.settled().catch((cause: unknown) => failures.push(cause));
		if (failures.length === 0) {
			await this.#storage.remove().catch((cause: unknown) => failures.push(cause));
		}
		this.#phase = "closed";
		if (failures.length > 0) {
			throw new TestRuntimeCleanupError(this.#storage.path, failures);
		}
	}
}

function validateOptions(
	options: unknown,
): ResolvedConfig & Readonly<{ services: ResolvedConfig["services"] }> {
	if (!isPlainRecord(options) || !hasExactDataProperties(options, ["config", "port", "storage"])) {
		throw new TypeError(
			'Test runtime options must be an exact plain { config, storage: "temporary", port: 0 } object.',
		);
	}
	if (dataProperty(options, "storage") !== "temporary") {
		throw new TypeError('Test runtime storage must be exactly "temporary".');
	}
	if (dataProperty(options, "port") !== 0) {
		throw new TypeError("Test runtime port must be exactly 0 for OS-assigned isolation.");
	}
	return resolveConfig(dataProperty(options, "config"), resolve("localhost.test.config.ts"));
}

function ownCreateInstanceOptions(options: unknown): Readonly<{ seed: boolean }> {
	if (!isPlainRecord(options) || !hasOnlyDataProperties(options, ["seed"])) {
		throw new TypeError("Test instance options must be a plain object containing only seed.");
	}
	const seed = dataProperty(options, "seed");
	if (seed !== undefined && typeof seed !== "boolean") {
		throw new TypeError("Test instance seed must be a boolean.");
	}
	return Object.freeze({ seed: seed ?? false });
}

function createTestInstanceId(): string {
	return `test-${randomUUID().replaceAll("-", "")}`;
}

function defaultDependencies(): TestRuntimeDependencies {
	return Object.freeze({
		createStorage: () => TemporaryRuntimeStorage.create(),
		correlationId: randomUUID,
		fetch: globalThis.fetch,
		token: randomUUID,
	});
}

function hasExactDataProperties(
	value: Readonly<Record<PropertyKey, unknown>>,
	keys: readonly string[],
): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.length && hasOnlyDataProperties(value, keys);
}

function hasOnlyDataProperties(
	value: Readonly<Record<PropertyKey, unknown>>,
	allowed: readonly string[],
): boolean {
	return Reflect.ownKeys(value).every((key) => {
		if (typeof key !== "string" || !allowed.includes(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.enumerable === true && "value" in descriptor;
	});
}

function dataProperty(value: Readonly<Record<PropertyKey, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
