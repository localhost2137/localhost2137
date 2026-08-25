type JsonPrimitive = boolean | number | string | null;
interface JsonArray extends ReadonlyArray<JsonValue> {}
export interface JsonObject {
	readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

class JsonOwnershipError extends TypeError {
	constructor(path: string, message: string) {
		super(`${message} at ${path}.`);
		this.name = "JsonOwnershipError";
	}
}

/** Copies JSON data without invoking accessors and freezes the resulting graph. */
export function ownJsonValue(value: unknown): JsonValue {
	return ownValue(value, "$", new WeakSet());
}

function ownValue(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new JsonOwnershipError(path, "Expected a finite number");
		return value;
	}
	if (Array.isArray(value)) return ownArray(value, path, ancestors);
	if (isPlainRecord(value)) return ownObject(value, path, ancestors);
	throw new JsonOwnershipError(path, `Unsupported ${typeof value} value`);
}

function ownArray(value: readonly unknown[], path: string, ancestors: WeakSet<object>): JsonArray {
	enter(value, path, ancestors);
	try {
		const result: JsonValue[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new JsonOwnershipError(`${path}[${index}]`, "Expected a dense data property");
			}
			result.push(ownValue(descriptor.value, `${path}[${index}]`, ancestors));
		}
		return Object.freeze(result);
	} finally {
		ancestors.delete(value);
	}
}

function ownObject(
	value: Readonly<Record<string, unknown>>,
	path: string,
	ancestors: WeakSet<object>,
): JsonObject {
	enter(value, path, ancestors);
	try {
		const result: Record<string, JsonValue> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable) continue;
			if (typeof key !== "string" || !("value" in descriptor)) {
				throw new JsonOwnershipError(propertyPath(path, key), "Expected a string data property");
			}
			Object.defineProperty(result, key, {
				configurable: false,
				enumerable: true,
				value: ownValue(descriptor.value, propertyPath(path, key), ancestors),
				writable: false,
			});
		}
		return Object.freeze(result);
	} finally {
		ancestors.delete(value);
	}
}

function enter(value: object, path: string, ancestors: WeakSet<object>): void {
	if (ancestors.has(value)) throw new JsonOwnershipError(path, "Expected an acyclic value");
	ancestors.add(value);
}

function propertyPath(parent: string, key: PropertyKey): string {
	if (typeof key === "string" && /^[A-Za-z_$][\w$]*$/.test(key)) return `${parent}.${key}`;
	return `${parent}[${JSON.stringify(String(key))}]`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
