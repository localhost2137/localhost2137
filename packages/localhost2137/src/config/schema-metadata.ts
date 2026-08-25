import { z } from "zod";
import type { OperationShape, Schema } from "../authoring/operation.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type CliScalarType = "boolean" | "integer" | "number" | "string";

export interface CliOption {
	readonly default?: JsonPrimitive | readonly JsonPrimitive[];
	readonly description?: string;
	readonly enum?: readonly JsonPrimitive[];
	readonly examples?: readonly JsonPrimitive[];
	readonly flag: `--${string}`;
	readonly name: string;
	readonly repeated: boolean;
	readonly required: boolean;
	readonly type: CliScalarType;
}

export type CliInputSchema =
	| Readonly<{ kind: "flags"; options: readonly CliOption[] }>
	| Readonly<{ kind: "json"; reason: string }>;

export interface OperationMetadata {
	readonly cli: CliInputSchema;
	readonly description: string;
	readonly input: JsonObject;
	readonly output: JsonObject;
}

export class SchemaIntrospectionError extends Error {
	override readonly cause: unknown;
	readonly schemaRole: "config" | "input" | "output" | "seed";

	constructor(schemaRole: "config" | "input" | "output" | "seed", cause: unknown) {
		super(`Could not convert ${schemaRole} schema to JSON Schema.`);
		this.name = "SchemaIntrospectionError";
		this.schemaRole = schemaRole;
		this.cause = cause;
	}
}

export function createOperationMetadata(operation: OperationShape): OperationMetadata {
	const input = createSchemaMetadata(operation.input, "input", "input");
	const output = createSchemaMetadata(operation.output, "output", "output");
	return Object.freeze({
		cli: compileCliInputSchema(input),
		description: operation.description,
		input,
		output,
	});
}

export function createSchemaMetadata(
	schema: Schema,
	schemaRole: "config" | "input" | "output" | "seed",
	io: "input" | "output" = "output",
): JsonObject {
	try {
		const jsonSchema: unknown = z.toJSONSchema(schema, {
			cycles: "throw",
			io,
			reused: "inline",
			target: "draft-2020-12",
			unrepresentable: "throw",
		});
		const normalized = normalizeJsonValue(jsonSchema);
		if (!isJsonObject(normalized)) {
			throw new TypeError("Zod returned a non-object JSON Schema.");
		}
		return freezeJsonObject(normalized);
	} catch (cause) {
		if (cause instanceof SchemaIntrospectionError) {
			throw cause;
		}
		throw new SchemaIntrospectionError(schemaRole, cause);
	}
}

export function compileCliInputSchema(schema: JsonObject): CliInputSchema {
	if (schema.type !== "object") {
		return jsonFallback("Operation input JSON Schema is not an object.");
	}
	if (!isJsonObject(schema.properties)) {
		return jsonFallback("Operation input JSON Schema has no object properties.");
	}
	if (hasComposition(schema)) {
		return jsonFallback("Operation input uses a nested, referenced, or union schema.");
	}

	const required = stringSet(schema.required);
	if (!required) {
		return jsonFallback("Operation input has an invalid required-property list.");
	}

	const flags = new Set<string>();
	const options: CliOption[] = [];
	for (const [name, property] of Object.entries(schema.properties)) {
		if (!isJsonObject(property) || hasComposition(property)) {
			return jsonFallback(`Field "${name}" requires nested, referenced, or union JSON input.`);
		}

		const compiled = compileProperty(name, property, required.has(name));
		if (typeof compiled === "string") {
			return jsonFallback(compiled);
		}
		if (flags.has(compiled.flag)) {
			return jsonFallback(`Fields collide on generated CLI flag "${compiled.flag}".`);
		}
		flags.add(compiled.flag);
		options.push(Object.freeze(compiled));
	}

	return Object.freeze({ kind: "flags", options: Object.freeze(options) });
}

function compileProperty(name: string, schema: JsonObject, required: boolean): CliOption | string {
	if (schema.type === "array") {
		if (!isJsonObject(schema.items) || hasComposition(schema.items)) {
			return `Array field "${name}" does not have scalar items.`;
		}
		const scalar = compileScalar(schema.items);
		if (typeof scalar === "string") {
			return `Array field "${name}" ${scalar}`;
		}
		const defaultValue = scalarArray(schema.default);
		if (schema.default !== undefined && !defaultValue) {
			return `Array field "${name}" has a non-scalar default.`;
		}
		return option(name, schema, scalar, required, true, defaultValue);
	}

	const scalar = compileScalar(schema);
	if (typeof scalar === "string") {
		return `Field "${name}" ${scalar}`;
	}
	const defaultValue = jsonPrimitive(schema.default);
	if (schema.default !== undefined && defaultValue === undefined) {
		return `Field "${name}" has a non-scalar default.`;
	}
	return option(name, schema, scalar, required, false, defaultValue);
}

interface CompiledScalar {
	readonly enum?: readonly JsonPrimitive[];
	readonly type: CliScalarType;
}

function compileScalar(schema: JsonObject): CompiledScalar | string {
	if (!isCliScalarType(schema.type)) {
		return "is not a supported scalar.";
	}
	const type = schema.type;
	const enumValues = scalarArray(schema.enum);
	if (schema.enum !== undefined && (!enumValues || enumValues.length === 0)) {
		return "has a non-scalar or empty enum.";
	}
	if (enumValues?.some((value) => !matchesType(value, type))) {
		return "has enum values that do not match its scalar type.";
	}
	return enumValues
		? Object.freeze({ enum: Object.freeze(enumValues), type })
		: Object.freeze({ type });
}

function option(
	name: string,
	schema: JsonObject,
	scalar: CompiledScalar,
	required: boolean,
	repeated: boolean,
	defaultValue: JsonPrimitive | readonly JsonPrimitive[] | undefined,
): CliOption {
	const description = typeof schema.description === "string" ? schema.description : undefined;
	const examples = scalarArray(schema.examples);
	return {
		...(defaultValue === undefined ? {} : { default: defaultValue }),
		...(description === undefined ? {} : { description }),
		...(scalar.enum === undefined ? {} : { enum: scalar.enum }),
		...(examples === undefined ? {} : { examples: Object.freeze(examples) }),
		flag: `--${toKebabCase(name)}`,
		name,
		repeated,
		required,
		type: scalar.type,
	};
}

function hasComposition(schema: JsonObject): boolean {
	return ["$ref", "allOf", "anyOf", "not", "oneOf"].some((key) => schema[key] !== undefined);
}

function stringSet(value: JsonValue | undefined): ReadonlySet<string> | undefined {
	if (value === undefined) {
		return new Set();
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		return undefined;
	}
	return new Set(value);
}

function isCliScalarType(value: JsonValue | undefined): value is CliScalarType {
	return value === "boolean" || value === "integer" || value === "number" || value === "string";
}

function matchesType(value: JsonPrimitive, type: CliScalarType): boolean {
	switch (type) {
		case "boolean":
			return typeof value === "boolean";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number";
		case "string":
			return typeof value === "string";
	}
}

function jsonPrimitive(value: JsonValue | undefined): JsonPrimitive | undefined {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	return undefined;
}

function scalarArray(value: JsonValue | undefined): JsonPrimitive[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: JsonPrimitive[] = [];
	for (const entry of value) {
		const primitive = jsonPrimitive(entry);
		if (primitive === undefined) {
			return undefined;
		}
		result.push(primitive);
	}
	return result;
}

function jsonFallback(reason: string): CliInputSchema {
	return Object.freeze({ kind: "json", reason });
}

function toKebabCase(value: string): string {
	return value
		.replace(/([a-z\d])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/[_\s]+/g, "-")
		.toLowerCase();
}

function normalizeJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeJsonValue);
	}
	if (isUnknownRecord(value)) {
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				result[key] = normalizeJsonValue(entry);
			}
		}
		return result;
	}
	throw new TypeError("Value is not JSON-compatible.");
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeJsonObject(value: JsonObject): JsonObject {
	for (const entry of Object.values(value)) {
		if (Array.isArray(entry)) {
			for (const item of entry) {
				if (isJsonObject(item)) {
					freezeJsonObject(item);
				}
			}
			Object.freeze(entry);
		} else if (isJsonObject(entry)) {
			freezeJsonObject(entry);
		}
	}
	return Object.freeze(value);
}
