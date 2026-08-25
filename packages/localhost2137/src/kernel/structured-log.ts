import { z } from "zod";
import { redact } from "./redaction.js";

type LogKind = "delivery" | "lifecycle" | "operation" | "plugin" | "request" | "task";
type LogStatus = "failed" | "started" | "succeeded";
type JsonPrimitive = boolean | number | string | null;
interface SafeLogArray extends ReadonlyArray<SafeLogValue> {}
interface SafeLogObject {
	readonly [key: string]: SafeLogValue;
}
type SafeLogValue = JsonPrimitive | SafeLogArray | SafeLogObject;

const timestampSchema = z.iso
	.datetime({ offset: true })
	.refine((value) => Number.isFinite(Date.parse(value)));

export interface StructuredLogInput {
	readonly attributes?: Readonly<Record<string, unknown>>;
	readonly correlationId: string;
	readonly durationMs?: number;
	readonly instanceId: string;
	readonly kind: LogKind;
	readonly message: string;
	readonly serviceKey?: string;
	readonly status: LogStatus;
	readonly virtualTime?: string;
	readonly wallTime: string;
}

export interface StructuredLogEntry {
	readonly attributes?: SafeLogObject;
	readonly correlationId: string;
	readonly durationMs?: number;
	readonly instanceId: string;
	readonly kind: LogKind;
	readonly message: string;
	readonly serviceKey?: string;
	readonly status: LogStatus;
	readonly virtualTime?: string;
	readonly wallTime: string;
}

export interface StructuredLogSnapshot {
	readonly droppedEntries: number;
	readonly entries: readonly StructuredLogEntry[];
}

export interface StructuredLogLimits {
	readonly maxBytes: number;
	readonly maxEntries: number;
}

export class StructuredLogRing {
	readonly #limits: StructuredLogLimits;
	readonly #entries: Array<Readonly<{ bytes: number; entry: StructuredLogEntry }>> = [];
	#bytes = 0;
	#droppedEntries = 0;

	constructor(limits: StructuredLogLimits) {
		if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) {
			throw new TypeError("Structured log maxEntries must be a positive safe integer.");
		}
		if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
			throw new TypeError("Structured log maxBytes must be a positive safe integer.");
		}
		this.#limits = Object.freeze({ ...limits });
	}

	append(input: StructuredLogInput): boolean {
		const entry = ownLogEntry(input);
		const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
		if (bytes > this.#limits.maxBytes) {
			this.#droppedEntries += 1;
			return false;
		}
		this.#entries.push(Object.freeze({ bytes, entry }));
		this.#bytes += bytes;
		while (this.#entries.length > this.#limits.maxEntries || this.#bytes > this.#limits.maxBytes) {
			const removed = this.#entries.shift();
			if (!removed) break;
			this.#bytes -= removed.bytes;
			this.#droppedEntries += 1;
		}
		return true;
	}

	snapshot(options: Readonly<{ tail?: number }> = {}): StructuredLogSnapshot {
		const tail = options.tail ?? this.#entries.length;
		if (!Number.isSafeInteger(tail) || tail < 0) {
			throw new TypeError("Structured log tail must be a non-negative safe integer.");
		}
		const entries = this.#entries.slice(Math.max(0, this.#entries.length - tail), undefined);
		return Object.freeze({
			droppedEntries: this.#droppedEntries,
			entries: Object.freeze(entries.map(({ entry }) => entry)),
		});
	}
}

function ownLogEntry(input: StructuredLogInput): StructuredLogEntry {
	if (
		input.durationMs !== undefined &&
		(!Number.isFinite(input.durationMs) || input.durationMs < 0)
	) {
		throw new TypeError("Structured log durationMs must be a non-negative finite number.");
	}
	assertTimestamp(input.wallTime, "wallTime");
	if (input.virtualTime !== undefined) assertTimestamp(input.virtualTime, "virtualTime");
	const attributes = input.attributes
		? safeLogObject(redact(input.attributes), new WeakSet())
		: undefined;
	return Object.freeze({
		...(attributes ? { attributes } : {}),
		correlationId: input.correlationId,
		...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
		instanceId: input.instanceId,
		kind: input.kind,
		message: input.message,
		...(input.serviceKey === undefined ? {} : { serviceKey: input.serviceKey }),
		status: input.status,
		...(input.virtualTime === undefined ? {} : { virtualTime: input.virtualTime }),
		wallTime: input.wallTime,
	});
}

function safeLogObject(value: unknown, ancestors: WeakSet<object>): SafeLogObject {
	if (!isRecord(value)) return Object.freeze({ value: safeLogValue(value, ancestors) });
	const result: Record<string, SafeLogValue> = Object.create(null);
	for (const [key, entry] of Object.entries(value)) {
		defineSafeEntry(result, key, isBodyKey(key) ? "[OMITTED]" : safeLogValue(entry, ancestors));
	}
	return Object.freeze(result);
}

function safeLogValue(value: unknown, ancestors: WeakSet<object>): SafeLogValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return "[CIRCULAR]";
		ancestors.add(value);
		const result = Object.freeze(Array.from(value, (entry) => safeLogValue(entry, ancestors)));
		ancestors.delete(value);
		return result;
	}
	if (isRecord(value)) {
		if (ancestors.has(value)) return "[CIRCULAR]";
		ancestors.add(value);
		const result: Record<string, SafeLogValue> = Object.create(null);
		for (const [key, entry] of Object.entries(value)) {
			defineSafeEntry(result, key, isBodyKey(key) ? "[OMITTED]" : safeLogValue(entry, ancestors));
		}
		ancestors.delete(value);
		return Object.freeze(result);
	}
	return `[UNSERIALIZABLE:${typeof value}]`;
}

function defineSafeEntry(
	target: Record<string, SafeLogValue>,
	key: string,
	value: SafeLogValue,
): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function assertTimestamp(value: string, field: "virtualTime" | "wallTime"): void {
	if (!timestampSchema.safeParse(value).success) {
		throw new TypeError(`Structured log ${field} must be a valid RFC 3339 timestamp.`);
	}
}

function isBodyKey(key: string): boolean {
	return /^(?:body|payload|requestBody|responseBody)$/i.test(key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
