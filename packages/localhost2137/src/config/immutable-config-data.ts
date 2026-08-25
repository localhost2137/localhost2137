type ImmutableConfigPrimitive = boolean | number | string | null;
export interface ImmutableConfigObject {
	readonly [key: string]: ImmutableConfigData;
}
interface ImmutableConfigArray extends ReadonlyArray<ImmutableConfigData> {}
export type ImmutableConfigData =
	| ImmutableConfigPrimitive
	| ImmutableConfigObject
	| ImmutableConfigArray;

export class ImmutableConfigDataError extends TypeError {
	readonly path: string;
	readonly received: string;

	constructor(path: string, received: string, reason: string) {
		super(`${path} ${reason}`);
		this.name = "ImmutableConfigDataError";
		this.path = path;
		this.received = received;
	}
}

/**
 * Own and freeze data crossing from a Zod parser or plugin callback.
 *
 * Resolved config deliberately supports JSON-compatible data only. Cloning
 * before freezing prevents plugin callbacks from retaining a mutable alias;
 * rejecting Date, Map, class instances, undefined, and cycles avoids claiming
 * immutability that Object.freeze cannot provide.
 */
export function ownImmutableConfigData(value: unknown, path: string): ImmutableConfigData {
	return ownValue(value, path, new WeakSet());
}

function ownValue(value: unknown, path: string, ancestors: WeakSet<object>): ImmutableConfigData {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) {
			return value;
		}
		throw new ImmutableConfigDataError(path, "number", "must contain a finite number.");
	}
	if (Array.isArray(value)) {
		assertAcyclic(value, path, ancestors);
		const owned: ImmutableConfigData[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const entryPath = `${path}[${index}]`;
			if (!Object.hasOwn(value, index)) {
				throw new ImmutableConfigDataError(
					entryPath,
					"missing array item",
					"must belong to a dense JSON array.",
				);
			}
			owned.push(ownValue(value[index], entryPath, ancestors));
		}
		ancestors.delete(value);
		return Object.freeze(owned);
	}
	if (isPlainRecord(value)) {
		assertAcyclic(value, path, ancestors);
		const owned: Record<string, ImmutableConfigData> = {};
		for (const [key, entry] of Object.entries(value)) {
			Object.defineProperty(owned, key, {
				configurable: false,
				enumerable: true,
				value: ownValue(entry, propertyPath(path, key), ancestors),
				writable: false,
			});
		}
		ancestors.delete(value);
		return Object.freeze(owned);
	}

	throw new ImmutableConfigDataError(
		path,
		receivedKind(value),
		"must be JSON-compatible plain data (null, boolean, finite number, string, array, or plain object).",
	);
}

function assertAcyclic(value: object, path: string, ancestors: WeakSet<object>): void {
	if (ancestors.has(value)) {
		throw new ImmutableConfigDataError(path, "cyclic object", "must not contain a cycle.");
	}
	ancestors.add(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function propertyPath(parent: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function receivedKind(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value !== "object" || value === null) return typeof value;
	return value.constructor?.name ?? "non-plain object";
}
