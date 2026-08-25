import { randomBytes } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { ownControlToken } from "../control/control-client.js";
import { ownRuntimeDescriptor, type RuntimeDescriptor } from "../control/runtime-descriptor.js";
import { readRuntimeDescriptorFile } from "./active-runtime-file-reader.js";
import {
	AtomicWriteError,
	syncDirectory,
	writeJsonAtomically,
	writeTextAtomically,
} from "./atomic-file.js";
import { type StoragePaths, storagePaths } from "./storage-paths.js";

export interface RuntimeDescriptorCreationInput {
	readonly configFingerprint: string;
	readonly ownerId?: string;
	readonly pid?: number;
	readonly startedAt?: string;
	readonly url: string;
}

/** Owns the two fixed active-runtime files for a storage root held under its daemon lock. */
export class ActiveRuntimeFileStore {
	readonly #paths: StoragePaths;

	constructor(storageRoot: string) {
		if (typeof storageRoot !== "string" || storageRoot.trim() === "") {
			throw new TypeError("Active runtime storage root must be a non-empty string.");
		}
		this.#paths = storagePaths(storageRoot);
	}

	async publish(descriptorValue: unknown, tokenValue: unknown): Promise<void> {
		const descriptor = ownRuntimeDescriptor(descriptorValue);
		const token = ownControlToken(tokenValue);
		await mkdir(this.#paths.root, { recursive: true });
		await writeTextAtomically(this.#paths.controlToken, `${token}\n`, { mode: 0o600 });
		try {
			await writeJsonAtomically(this.#paths.runtime, descriptor, { mode: 0o600 });
		} catch (cause) {
			if (cause instanceof AtomicWriteError && cause.commitState === "committed") throw cause;
			const cleanupFailures: unknown[] = [];
			await unlink(this.#paths.controlToken).catch((failure: unknown) => {
				if (!hasCode(failure, "ENOENT")) cleanupFailures.push(failure);
			});
			await syncDirectory(this.#paths.root).catch((failure: unknown) =>
				cleanupFailures.push(failure),
			);
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[cause, ...cleanupFailures],
					"Publishing active runtime files failed and token cleanup was incomplete.",
				);
			}
			throw cause;
		}
	}

	async remove(ownerId: string): Promise<boolean> {
		if (typeof ownerId !== "string" || ownerId.length < 1) {
			throw new TypeError("Active runtime removal requires an owner id.");
		}
		let descriptor: RuntimeDescriptor;
		try {
			descriptor = await readRuntimeDescriptorFile(this.#paths.runtime);
		} catch (cause) {
			if (hasCode(cause, "ENOENT")) return false;
			throw cause;
		}
		if (descriptor.ownerId !== ownerId) return false;
		await unlink(this.#paths.runtime);
		await syncDirectory(this.#paths.root);
		await unlink(this.#paths.controlToken).catch((cause: unknown) => {
			if (!hasCode(cause, "ENOENT")) throw cause;
		});
		await syncDirectory(this.#paths.root);
		return true;
	}
}

export function createRuntimeDescriptor(
	inputValue: RuntimeDescriptorCreationInput,
): RuntimeDescriptor {
	const input = ownDescriptorCreationInput(inputValue);
	return ownRuntimeDescriptor({
		configFingerprint: input.configFingerprint,
		ownerId: input.ownerId ?? generateRuntimeOwnerId(),
		pid: input.pid ?? process.pid,
		protocolVersion: "v1",
		schemaVersion: 1,
		startedAt: input.startedAt ?? new Date().toISOString(),
		url: input.url,
	});
}

export function generateControlToken(): string {
	return randomBytes(32).toString("base64url");
}

export function generateRuntimeOwnerId(): string {
	return `runtime_${randomBytes(24).toString("base64url")}`;
}

function ownDescriptorCreationInput(value: unknown): Readonly<{
	configFingerprint: unknown;
	ownerId?: unknown;
	pid?: unknown;
	startedAt?: unknown;
	url: unknown;
}> {
	if (!isPlainRecord(value)) {
		throw new TypeError("Runtime descriptor creation input must be a plain object.");
	}
	for (const key of Reflect.ownKeys(value)) {
		if (
			typeof key !== "string" ||
			!["configFingerprint", "ownerId", "pid", "startedAt", "url"].includes(key)
		) {
			throw new TypeError(
				`Runtime descriptor creation input contains unknown field ${String(key)}.`,
			);
		}
	}
	const configFingerprint = requiredDataProperty(value, "configFingerprint");
	const url = requiredDataProperty(value, "url");
	const ownerId = optionalDataProperty(value, "ownerId");
	const pid = optionalDataProperty(value, "pid");
	const startedAt = optionalDataProperty(value, "startedAt");
	return Object.freeze({
		configFingerprint,
		...(ownerId === undefined ? {} : { ownerId }),
		...(pid === undefined ? {} : { pid }),
		...(startedAt === undefined ? {} : { startedAt }),
		url,
	});
}

function optionalDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor) || !descriptor.enumerable) {
		throw new TypeError(`Runtime descriptor creation field ${key} must be a data property.`);
	}
	return descriptor.value;
}

function requiredDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) throw new TypeError(`Runtime descriptor creation field ${key} is required.`);
	if (!("value" in descriptor) || !descriptor.enumerable) {
		throw new TypeError(`Runtime descriptor creation field ${key} must be a data property.`);
	}
	return descriptor.value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
