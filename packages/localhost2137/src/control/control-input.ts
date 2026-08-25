import { LocalhostError } from "../authoring/localhost-error.js";

export interface CreateInstanceInput {
	readonly id: string;
	readonly persistence: "ephemeral" | "persistent";
	readonly seed: boolean;
}

export function parseCreateInstance(value: unknown): CreateInstanceInput {
	const input = strictObject(value, ["id", "persistence", "seed"]);
	if (typeof input.id !== "string") invalid("Instance create requires a string id.");
	if (
		input.persistence !== undefined &&
		input.persistence !== "ephemeral" &&
		input.persistence !== "persistent"
	) {
		invalid('Instance persistence must be "persistent" or "ephemeral".');
	}
	if (input.seed !== undefined && typeof input.seed !== "boolean") {
		invalid("Instance seed must be a boolean.");
	}
	return Object.freeze({
		id: input.id,
		persistence: input.persistence ?? "persistent",
		seed: input.seed ?? false,
	});
}

export function parseResetInstance(value: unknown): Readonly<{ seed: boolean }> {
	const input = strictObject(value, ["seed"]);
	if (input.seed !== undefined && typeof input.seed !== "boolean") {
		invalid("Instance reset seed must be a boolean.");
	}
	return Object.freeze({ seed: input.seed ?? false });
}

export function parseIdle(value: unknown): Readonly<{ timeoutMs: number }> {
	const input = strictObject(value, ["timeoutMs"]);
	const timeoutMs = input.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 0 || Number(timeoutMs) > 120_000) {
		invalid("Idle timeoutMs must be a safe integer between 0 and 120000.");
	}
	return Object.freeze({ timeoutMs: Number(timeoutMs) });
}

export function parseEmptyMutation(value: unknown): void {
	strictObject(value, []);
}

function strictObject(
	value: unknown,
	allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) invalid("Control request body must be a JSON object.");
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
	if (unknownKey) invalid(`Control request body contains unknown field "${unknownKey}".`);
	return value;
}

function invalid(message: string): never {
	throw new LocalhostError("INVALID_REQUEST", message, { status: 400 });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
