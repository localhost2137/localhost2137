import { createHash } from "node:crypto";

export function createConfigFingerprint(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableSerialize(value)).digest("hex")}`;
}

function stableSerialize(value: unknown): string {
	return JSON.stringify(canonicalize(value, new WeakSet()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (value === undefined) {
		return { $undefined: true };
	}
	if (typeof value === "bigint") {
		return { $bigint: value.toString() };
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return { $type: typeof value };
	}
	if (seen.has(value)) {
		throw new TypeError("Cannot fingerprint a cyclic configuration value.");
	}
	seen.add(value);

	if (Array.isArray(value)) {
		const result = value.map((entry) => canonicalize(entry, seen));
		seen.delete(value);
		return result;
	}
	if (value instanceof Date) {
		seen.delete(value);
		return { $date: value.toISOString() };
	}
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	const result = Object.fromEntries(
		entries.map(([key, entry]) => [key, canonicalize(entry, seen)]),
	);
	seen.delete(value);
	return result;
}
