export type OperationJsonPrimitive = boolean | number | string | null;
export interface OperationJsonArray extends ReadonlyArray<OperationJsonValue> {}
export interface OperationJsonObject {
	readonly [key: string]: OperationJsonValue;
}
export type OperationJsonValue = OperationJsonPrimitive | OperationJsonArray | OperationJsonObject;

export class OperationJsonError extends TypeError {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${message} at ${path}.`);
		this.name = "OperationJsonError";
		this.path = path;
	}
}

export function ownOperationJson(value: unknown): OperationJsonValue {
	return ownValue(value, "$", new WeakSet());
}

function ownValue(value: unknown, path: string, ancestors: WeakSet<object>): OperationJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new OperationJsonError(path, "Expected a finite number");
		return value;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new OperationJsonError(path, "Expected an acyclic value");
		ancestors.add(value);
		const result: OperationJsonValue[] = [];
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index)) {
				throw new OperationJsonError(`${path}[${index}]`, "Sparse arrays are not supported");
			}
			result.push(ownValue(value[index], `${path}[${index}]`, ancestors));
		}
		ancestors.delete(value);
		return Object.freeze(result);
	}
	if (isPlainRecord(value)) {
		if (ancestors.has(value)) throw new OperationJsonError(path, "Expected an acyclic value");
		ancestors.add(value);
		const result: Record<string, OperationJsonValue> = Object.create(null);
		for (const [key, entry] of Object.entries(value)) {
			Object.defineProperty(result, key, {
				configurable: false,
				enumerable: true,
				value: ownValue(entry, propertyPath(path, key), ancestors),
				writable: false,
			});
		}
		ancestors.delete(value);
		return Object.freeze(result);
	}
	throw new OperationJsonError(path, `Unsupported ${typeof value} value`);
}

function propertyPath(parent: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
