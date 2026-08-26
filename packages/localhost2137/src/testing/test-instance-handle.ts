import type {
	InstanceClockAdvanceResult,
	InstanceClockStatus,
	InstanceHandle,
	ServiceRecord,
} from "../authoring/config.js";
import { ownJsonValue } from "../authoring/json-value.js";
import type { ResolvedConfig } from "../config/config-resolution.js";
import { resolveInstanceConnections } from "../config/instance-connections.js";
import type { ControlClient } from "../control/control-client.js";
import type { ControlJsonValue } from "../control/control-client-errors.js";
import { TestInstanceBusyError, TestInstanceClosedError } from "./test-runtime-errors.js";

const LIFECYCLE_TIMEOUT_MS = 30_000;

export interface TestRuntimeGate {
	assertOpen(): void;
}

export function createTestInstanceHandle<Services extends ServiceRecord>(
	input: Readonly<{
		client: ControlClient;
		config: ResolvedConfig;
		instanceId: string;
		runtime: TestRuntimeGate;
		url: string;
	}>,
): InstanceHandle<Services> {
	const owner = new TestInstanceHandleOwner(input.client, input.instanceId, input.runtime);
	const connections = resolveInstanceConnections(input.config, {
		baseUrl: input.url,
		instanceId: input.instanceId,
	});
	const handle: Record<string, unknown> = Object.create(null);

	for (const [serviceKey, service] of Object.entries(input.config.services)) {
		const serviceHandle: Record<string, unknown> = Object.create(null);
		const connection = connections.services[serviceKey];
		if (!connection) {
			throw new TypeError(`Resolved service "${serviceKey}" has no connection metadata.`);
		}
		defineEntry(serviceHandle, "connection", connection.values);
		for (const operationKey of Object.keys(service.operations)) {
			defineEntry(serviceHandle, operationKey, (operationInput: unknown) =>
				owner.execute(serviceKey, operationKey, operationInput),
			);
		}
		defineEntry(handle, serviceKey, Object.freeze(serviceHandle));
	}

	defineEntry(
		handle,
		"clock",
		Object.freeze({
			advance: (duration: string) => owner.clockAdvance(duration),
			status: () => owner.clockStatus(),
		}),
	);
	defineEntry(handle, "destroy", () => owner.destroy());
	defineEntry(handle, "env", connections.env);
	defineEntry(handle, "idle", () => owner.idle());
	defineEntry(handle, "reset", (options?: Readonly<{ seed?: boolean }>) => owner.reset(options));
	defineEntry(handle, "seed", () => owner.seed());

	// Config resolution proves that every typed service and operation has a
	// matching generated data property. This cast closes that construction boundary.
	return Object.freeze(handle) as InstanceHandle<Services>;
}

class TestInstanceHandleOwner {
	readonly #client: ControlClient;
	#destroyPromise: Promise<void> | undefined;
	readonly #instanceId: string;
	#mutation: Promise<unknown> | undefined;
	readonly #runtime: TestRuntimeGate;
	#state: "active" | "destroying" = "active";

	constructor(client: ControlClient, instanceId: string, runtime: TestRuntimeGate) {
		this.#client = client;
		this.#instanceId = instanceId;
		this.#runtime = runtime;
	}

	execute(serviceKey: string, operationKey: string, input: unknown): Promise<ControlJsonValue> {
		try {
			this.#assertUsable();
			return this.#client.executeOperation(
				this.#instanceId,
				serviceKey,
				operationKey,
				ownJsonValue(input),
			);
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	async clockStatus(): Promise<InstanceClockStatus> {
		this.#assertUsable();
		return ownClockStatus(await this.#client.clockStatus(this.#instanceId));
	}

	clockAdvance(duration: string): Promise<InstanceClockAdvanceResult> {
		try {
			this.#assertUsable();
			if (typeof duration !== "string") throw new TypeError("Clock duration must be a string.");
			return this.#beginMutation(() =>
				this.#client
					.clockAdvance(this.#instanceId, duration)
					.then((value) => ownClockAdvanceResult(value)),
			);
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	destroy(): Promise<void> {
		if (this.#destroyPromise) return this.#destroyPromise;
		try {
			this.#runtime.assertOpen();
		} catch (cause) {
			return Promise.reject(cause);
		}
		if (this.#mutation) return Promise.reject(new TestInstanceBusyError(this.#instanceId));
		this.#state = "destroying";
		this.#destroyPromise = this.#client.destroyInstance(this.#instanceId).then(() => undefined);
		return this.#destroyPromise;
	}

	idle(): Promise<void> {
		try {
			this.#assertUsable();
			return this.#client
				.idle(this.#instanceId, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
				.then(() => undefined);
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	reset(options: Readonly<{ seed?: boolean }> = {}): Promise<void> {
		try {
			this.#assertUsable();
			const owned = ownResetOptions(options);
			return this.#beginMutation(() =>
				this.#client.resetInstance(this.#instanceId, { seed: owned.seed }).then(() => undefined),
			);
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	seed(): Promise<void> {
		try {
			this.#assertUsable();
			return this.#beginMutation(() =>
				this.#client.seedInstance(this.#instanceId).then(() => undefined),
			);
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	#assertUsable(): void {
		this.#runtime.assertOpen();
		if (this.#state !== "active") throw new TestInstanceClosedError(this.#instanceId);
	}

	#beginMutation<Value>(start: () => Promise<Value>): Promise<Value> {
		if (this.#mutation) return Promise.reject(new TestInstanceBusyError(this.#instanceId));
		let operation: Promise<Value>;
		try {
			operation = start();
		} catch (cause) {
			return Promise.reject(cause);
		}
		const tracked = operation.finally(() => {
			if (this.#mutation === tracked) this.#mutation = undefined;
		});
		this.#mutation = tracked;
		return tracked;
	}
}

function ownClockStatus(value: ControlJsonValue): InstanceClockStatus {
	if (!isControlObject(value) || !hasExactKeys(value, ["mode", "now"])) {
		throw new TypeError("Runtime clock response must be an exact { mode, now } object.");
	}
	if (value.mode !== "pinned" && value.mode !== "real") {
		throw new TypeError("Runtime clock response has an invalid mode.");
	}
	if (typeof value.now !== "string" || Number.isNaN(Date.parse(value.now))) {
		throw new TypeError("Runtime clock response has an invalid RFC 3339 timestamp.");
	}
	return Object.freeze({ mode: value.mode, now: value.now });
}

function ownClockAdvanceResult(value: ControlJsonValue): InstanceClockAdvanceResult {
	if (!isControlObject(value) || !hasExactKeys(value, ["advanceId", "from", "mode", "to"])) {
		throw new TypeError(
			"Runtime clock advance response must be an exact { advanceId, from, mode, to } object.",
		);
	}
	if (typeof value.advanceId !== "string" || value.advanceId.length === 0) {
		throw new TypeError("Runtime clock advance response has an invalid advanceId.");
	}
	if (value.mode !== "pinned" && value.mode !== "real") {
		throw new TypeError("Runtime clock advance response has an invalid mode.");
	}
	if (
		typeof value.from !== "string" ||
		typeof value.to !== "string" ||
		Number.isNaN(Date.parse(value.from)) ||
		Number.isNaN(Date.parse(value.to))
	) {
		throw new TypeError("Runtime clock advance response has invalid RFC 3339 timestamps.");
	}
	return Object.freeze({
		advanceId: value.advanceId,
		from: value.from,
		mode: value.mode,
		to: value.to,
	});
}

function ownResetOptions(options: unknown): Readonly<{ seed: boolean }> {
	if (!isPlainRecord(options) || !hasOnlyDataProperties(options, ["seed"])) {
		throw new TypeError("Instance reset options must be a plain object containing only seed.");
	}
	const seed = dataProperty(options, "seed");
	if (seed !== undefined && typeof seed !== "boolean") {
		throw new TypeError("Instance reset seed must be a boolean.");
	}
	return Object.freeze({ seed: seed ?? false });
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function dataProperty(value: Readonly<Record<PropertyKey, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
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

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isControlObject(
	value: ControlJsonValue,
): value is Readonly<Record<string, ControlJsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
