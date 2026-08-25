import { ownJsonValue } from "../authoring/json-value.js";
import {
	type ControlJsonObject,
	type ControlJsonValue,
	ControlTransportError,
} from "./control-client-errors.js";
import { CONTROL_RESPONSE_BODY_LIMIT_BYTES, readControlResponse } from "./control-response.js";
import { ownLoopbackRuntimeUrl } from "./runtime-descriptor.js";

export interface ConnectRuntimeOptions {
	readonly fetch?: typeof globalThis.fetch;
	readonly responseBodyLimitBytes?: number;
	readonly token: string;
	readonly url: string | URL;
}

export interface ControlRequestOptions {
	readonly signal?: AbortSignal;
}

export interface ControlInstanceCreateInput {
	readonly id: string;
	readonly persistence?: "ephemeral" | "persistent";
	readonly seed?: boolean;
}

export interface ControlLogOptions extends ControlRequestOptions {
	readonly service?: string;
	readonly tail?: number;
}

export function connectRuntime(options: ConnectRuntimeOptions): ControlClient {
	return new ControlClient(options);
}

/** An introspection-driven client for the versioned localhost2137 control API. */
export class ControlClient {
	readonly #baseUrl: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #responseBodyLimitBytes: number;
	readonly #token: string;

	constructor(options: ConnectRuntimeOptions) {
		const owned = ownOptions(options);
		this.#baseUrl = `${owned.url}/_/v1`;
		this.#fetch = owned.fetch;
		this.#responseBodyLimitBytes = owned.responseBodyLimitBytes;
		this.#token = owned.token;
	}

	get url(): string {
		return this.#baseUrl.slice(0, -"/_/v1".length);
	}

	health(options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request("health", { method: "GET", ...options });
	}

	listInstances(options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request("instances", { method: "GET", ...options });
	}

	createInstance(
		input: ControlInstanceCreateInput,
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		const body: ControlJsonObject = Object.freeze({
			id: input.id,
			persistence: input.persistence ?? "persistent",
			seed: input.seed ?? false,
		});
		return this.#request("instances", { body, method: "POST", ...options });
	}

	getInstance(instanceId: string, options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}`, { method: "GET", ...options });
	}

	destroyInstance(
		instanceId: string,
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}`, {
			body: Object.freeze({}),
			method: "DELETE",
			...options,
		});
	}

	resetInstance(
		instanceId: string,
		input: Readonly<{ seed?: boolean }> = {},
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/reset`, {
			body: Object.freeze({ seed: input.seed ?? false }),
			method: "POST",
			...options,
		});
	}

	seedInstance(instanceId: string, options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/seed`, {
			body: Object.freeze({}),
			method: "POST",
			...options,
		});
	}

	listServices(instanceId: string, options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/services`, {
			method: "GET",
			...options,
		});
	}

	describeService(
		instanceId: string,
		serviceKey: string,
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/services/${segment(serviceKey)}`, {
			method: "GET",
			...options,
		});
	}

	executeOperation(
		instanceId: string,
		serviceKey: string,
		operationKey: string,
		input: ControlJsonValue,
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		return this.#request(
			`instances/${segment(instanceId)}/services/${segment(serviceKey)}/operations/${segment(operationKey)}`,
			{ body: input, method: "POST", ...options },
		);
	}

	logs(instanceId: string, options: ControlLogOptions = {}): Promise<ControlJsonValue> {
		const query = new URLSearchParams();
		if (options.service !== undefined) query.set("service", options.service);
		if (options.tail !== undefined) query.set("tail", String(options.tail));
		const suffix = query.size > 0 ? `?${query.toString()}` : "";
		return this.#request(`instances/${segment(instanceId)}/logs${suffix}`, {
			method: "GET",
			...(options.signal ? { signal: options.signal } : {}),
		});
	}

	clockStatus(instanceId: string, options: ControlRequestOptions = {}): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/clock`, {
			method: "GET",
			...options,
		});
	}

	idle(
		instanceId: string,
		input: Readonly<{ timeoutMs?: number }> = {},
		options: ControlRequestOptions = {},
	): Promise<ControlJsonValue> {
		return this.#request(`instances/${segment(instanceId)}/idle`, {
			body: Object.freeze({ timeoutMs: input.timeoutMs ?? 30_000 }),
			method: "POST",
			...options,
		});
	}

	async #request(
		path: string,
		input: Readonly<{
			body?: ControlJsonValue;
			method: "DELETE" | "GET" | "POST";
			signal?: AbortSignal;
		}>,
	): Promise<ControlJsonValue> {
		const url = `${this.#baseUrl}/${path}`;
		const body = input.body === undefined ? undefined : JSON.stringify(ownJsonValue(input.body));
		let response: Response;
		try {
			response = await this.#fetch(url, {
				...(body === undefined ? {} : { body }),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.#token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				method: input.method,
				redirect: "error",
				...(input.signal ? { signal: input.signal } : {}),
			});
		} catch (cause) {
			throw new ControlTransportError(cause, input.signal?.aborted ?? false);
		}
		try {
			return await readControlResponse(response, this.#responseBodyLimitBytes);
		} catch (cause) {
			if (cause instanceof ControlTransportError && input.signal?.aborted) {
				throw new ControlTransportError(cause, true);
			}
			throw cause;
		}
	}
}

interface OwnedConnectRuntimeOptions {
	readonly fetch: typeof globalThis.fetch;
	readonly responseBodyLimitBytes: number;
	readonly token: string;
	readonly url: string;
}

function ownOptions(options: unknown): OwnedConnectRuntimeOptions {
	if (!isPlainRecord(options))
		throw new TypeError("Control client options must be a plain object.");
	for (const key of Reflect.ownKeys(options)) {
		if (
			typeof key !== "string" ||
			!["fetch", "responseBodyLimitBytes", "token", "url"].includes(key)
		) {
			throw new TypeError(`Control client options contain unknown field ${String(key)}.`);
		}
	}
	const rawUrl = dataProperty(options, "url", true);
	const url = ownLoopbackRuntimeUrl(rawUrl instanceof URL ? rawUrl.href : rawUrl, "options.url");
	const token = ownControlToken(dataProperty(options, "token", true));
	const rawFetch = dataProperty(options, "fetch", false);
	if (rawFetch !== undefined && typeof rawFetch !== "function") {
		throw new TypeError("Control client fetch must be a function.");
	}
	const fetchImplementation = rawFetch ?? globalThis.fetch;
	if (typeof fetchImplementation !== "function") {
		throw new TypeError("Control client requires a fetch implementation.");
	}
	const rawLimit = dataProperty(options, "responseBodyLimitBytes", false);
	const responseBodyLimitBytes = rawLimit ?? CONTROL_RESPONSE_BODY_LIMIT_BYTES;
	if (!Number.isSafeInteger(responseBodyLimitBytes) || Number(responseBodyLimitBytes) < 1) {
		throw new TypeError("Control response body limit must be a positive safe integer.");
	}
	return Object.freeze({
		fetch: fetchImplementation as typeof globalThis.fetch,
		responseBodyLimitBytes: Number(responseBodyLimitBytes),
		token,
		url,
	});
}

export function ownControlToken(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 512 || /\s/.test(value)) {
		throw new TypeError(
			"Control token must be a non-empty value of at most 512 characters without whitespace.",
		);
	}
	return value;
}

function segment(value: string): string {
	if (typeof value !== "string" || value.length < 1) {
		throw new TypeError("Control path identifiers must be non-empty strings.");
	}
	return encodeURIComponent(value);
}

function dataProperty(
	value: Readonly<Record<string, unknown>>,
	key: string,
	required: boolean,
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) {
		if (required) throw new TypeError(`Control client option ${key} is required.`);
		return undefined;
	}
	if (!("value" in descriptor) || !descriptor.enumerable) {
		throw new TypeError(`Control client option ${key} must be a data property.`);
	}
	return descriptor.value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export type {
	ControlClientFailureKind,
	ControlJsonArray,
	ControlJsonObject,
	ControlJsonPrimitive,
	ControlJsonValue,
} from "./control-client-errors.js";
export {
	ControlApiError,
	ControlProtocolError,
	ControlTransportError,
} from "./control-client-errors.js";
