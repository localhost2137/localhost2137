import { connectRuntime as connectControlRuntime } from "../control/control-client.js";
import type { ControlJsonValue } from "../control/control-client-errors.js";

export interface ConnectRuntimeOptions {
	readonly token: string;
	readonly url: string | URL;
}

export interface RuntimeClientRequestOptions {
	readonly signal?: AbortSignal;
}

export interface RuntimeClientCreateInput {
	readonly id: string;
	readonly persistence?: "ephemeral" | "persistent";
	readonly seed?: boolean;
}

export interface RuntimeClientLogOptions extends RuntimeClientRequestOptions {
	readonly service?: string;
	readonly tail?: number;
}

/** A deliberately untyped client whose data contracts are discovered at runtime. */
export interface RuntimeClient {
	readonly url: string;
	clockStatus(instanceId: string, options?: RuntimeClientRequestOptions): Promise<ControlJsonValue>;
	createInstance(
		input: RuntimeClientCreateInput,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	describeService(
		instanceId: string,
		serviceKey: string,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	destroyInstance(
		instanceId: string,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	executeOperation(
		instanceId: string,
		serviceKey: string,
		operationKey: string,
		input: ControlJsonValue,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	getInstance(instanceId: string, options?: RuntimeClientRequestOptions): Promise<ControlJsonValue>;
	health(options?: RuntimeClientRequestOptions): Promise<ControlJsonValue>;
	idle(
		instanceId: string,
		input?: Readonly<{ timeoutMs?: number }>,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	listInstances(options?: RuntimeClientRequestOptions): Promise<ControlJsonValue>;
	listServices(
		instanceId: string,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	logs(instanceId: string, options?: RuntimeClientLogOptions): Promise<ControlJsonValue>;
	resetInstance(
		instanceId: string,
		input?: Readonly<{ seed?: boolean }>,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
	seedInstance(
		instanceId: string,
		options?: RuntimeClientRequestOptions,
	): Promise<ControlJsonValue>;
}

/** Connect to an already-running loopback localhost2137 runtime. */
export function connectRuntime(options: ConnectRuntimeOptions): RuntimeClient {
	assertPublicOptions(options);
	return connectControlRuntime(options);
}

function assertPublicOptions(options: unknown): asserts options is ConnectRuntimeOptions {
	if (!isPlainRecord(options)) {
		throw new TypeError("Runtime client options must be a plain object.");
	}
	const keys = Reflect.ownKeys(options);
	if (keys.length !== 2 || !keys.includes("token") || !keys.includes("url")) {
		throw new TypeError("Runtime client options must contain exactly url and token.");
	}
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(options, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
			throw new TypeError("Runtime client options must contain enumerable data properties.");
		}
	}
}

function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
