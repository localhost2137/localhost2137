import { createHash } from "node:crypto";

/**
 * Fingerprints accept only normalized JSON data. Type-tagged canonical
 * encoding makes object keys distinct from values and avoids sentinel-shaped
 * user data colliding with special runtime representations.
 */
export function createConfigFingerprint(value: unknown): string {
	return `sha256:${createHash("sha256").update(encode(value, new WeakSet())).digest("hex")}`;
}

function encode(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null) return "null;";
	if (typeof value === "boolean") return value ? "bool:1;" : "bool:0;";
	if (typeof value === "string") return `str:${JSON.stringify(value)};`;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw unsupported(value);
		return `num:${Object.is(value, -0) ? "-0" : String(value)};`;
	}
	if (Array.isArray(value)) {
		assertAcyclic(value, ancestors);
		const entries: string[] = [];
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index)) {
				throw new TypeError(`Cannot fingerprint sparse config data (missing index ${index}).`);
			}
			entries.push(encode(value[index], ancestors));
		}
		const encoded = `array:${value.length}:[${entries.join("")}]`;
		ancestors.delete(value);
		return encoded;
	}
	if (isPlainRecord(value)) {
		assertAcyclic(value, ancestors);
		const keys = Object.keys(value).sort(codeUnitOrder);
		const encoded = `object:${keys.length}:{${keys
			.map((key) => `${encode(key, ancestors)}${encode(value[key], ancestors)}`)
			.join("")}}`;
		ancestors.delete(value);
		return encoded;
	}
	throw unsupported(value);
}

function codeUnitOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertAcyclic(value: object, ancestors: WeakSet<object>): void {
	if (ancestors.has(value)) throw new TypeError("Cannot fingerprint cyclic config data.");
	ancestors.add(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function unsupported(value: unknown): TypeError {
	return new TypeError(
		`Cannot fingerprint non-JSON config data (${value === undefined ? "undefined" : typeof value}).`,
	);
}
