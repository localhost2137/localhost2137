import { ownJsonValue } from "../authoring/json-value.js";
import type {
	CliInputSchema,
	CliOption,
	JsonObject,
	OperationMetadata,
} from "../config/schema-metadata.js";

export interface CliServiceDescription {
	readonly description: string;
	readonly name: string;
	readonly operationMetadata: Readonly<Record<string, OperationMetadata>>;
}

class CliServiceDescriptionError extends TypeError {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${message} at ${path}.`);
		this.name = "CliServiceDescriptionError";
		this.path = path;
	}
}

/** Owns the operation metadata consumed by generated CLI commands. */
export function ownCliServiceDescription(value: unknown): CliServiceDescription {
	const input = record(ownJsonValue(value), "$", [
		"description",
		"name",
		"operationMetadata",
		"operations",
		"pluginId",
		"stateVersion",
		"status",
	]);
	const description = text(input.description, "$.description");
	const name = text(input.name, "$.name");
	const rawOperations = record(input.operationMetadata, "$.operationMetadata");
	const operations: Record<string, OperationMetadata> = Object.create(null);
	for (const [operationKey, rawOperation] of Object.entries(rawOperations)) {
		defineEntry(
			operations,
			operationKey,
			ownOperationMetadata(rawOperation, `$.operationMetadata[${JSON.stringify(operationKey)}]`),
		);
	}
	return Object.freeze({
		description,
		name,
		operationMetadata: Object.freeze(operations),
	});
}

function ownOperationMetadata(value: unknown, path: string): OperationMetadata {
	const input = record(value, path, ["cli", "description", "input", "output"]);
	return Object.freeze({
		cli: ownCliInput(input.cli, `${path}.cli`),
		description: text(input.description, `${path}.description`),
		input: jsonObject(input.input, `${path}.input`),
		output: jsonObject(input.output, `${path}.output`),
	});
}

function ownCliInput(value: unknown, path: string): CliInputSchema {
	const input = record(value, path);
	if (input.kind === "json") {
		exactKeys(input, path, ["kind", "reason"]);
		return Object.freeze({ kind: "json", reason: text(input.reason, `${path}.reason`) });
	}
	if (input.kind !== "flags") {
		throw invalid(`${path}.kind`, 'Expected "flags" or "json"');
	}
	exactKeys(input, path, ["kind", "options"]);
	if (!Array.isArray(input.options)) throw invalid(`${path}.options`, "Expected an array");
	return Object.freeze({
		kind: "flags",
		options: Object.freeze(
			input.options.map((option, index) => ownCliOption(option, `${path}.options[${index}]`)),
		),
	});
}

function ownCliOption(value: unknown, path: string): CliOption {
	const input = record(value, path, [
		"default",
		"description",
		"enum",
		"examples",
		"flag",
		"name",
		"repeated",
		"required",
		"type",
	]);
	for (const required of ["flag", "name", "repeated", "required", "type"]) {
		if (!Object.hasOwn(input, required)) throw invalid(`${path}.${required}`, "Missing field");
	}
	const type = input.type;
	if (type !== "boolean" && type !== "integer" && type !== "number" && type !== "string") {
		throw invalid(`${path}.type`, "Expected a supported scalar type");
	}
	const flag = text(input.flag, `${path}.flag`);
	if (!/^--[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flag)) {
		throw invalid(`${path}.flag`, "Expected a safe long option");
	}
	const name = text(input.name, `${path}.name`);
	const repeated = boolean(input.repeated, `${path}.repeated`);
	const required = boolean(input.required, `${path}.required`);
	const defaultValue = optionalScalarOrArray(input.default, `${path}.default`);
	const enumValues = optionalScalarArray(input.enum, `${path}.enum`);
	const examples = optionalScalarArray(input.examples, `${path}.examples`);
	return Object.freeze({
		...(defaultValue === undefined ? {} : { default: defaultValue }),
		...(input.description === undefined
			? {}
			: { description: text(input.description, `${path}.description`) }),
		...(enumValues === undefined ? {} : { enum: enumValues }),
		...(examples === undefined ? {} : { examples }),
		flag: flag as `--${string}`,
		name,
		repeated,
		required,
		type,
	});
}

type Scalar = boolean | number | string | null;

function optionalScalarOrArray(
	value: unknown,
	path: string,
): Scalar | readonly Scalar[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return scalarArray(value, path);
	return scalar(value, path);
}

function optionalScalarArray(value: unknown, path: string): readonly Scalar[] | undefined {
	return value === undefined ? undefined : scalarArray(value, path);
}

function scalarArray(value: unknown, path: string): readonly Scalar[] {
	if (!Array.isArray(value)) throw invalid(path, "Expected an array");
	return Object.freeze(value.map((entry, index) => scalar(entry, `${path}[${index}]`)));
}

function scalar(value: unknown, path: string): Scalar {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	throw invalid(path, "Expected a JSON scalar");
}

function jsonObject(value: unknown, path: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalid(path, "Expected a JSON object");
	}
	return value as JsonObject;
}

function record(
	value: unknown,
	path: string,
	allowedKeys?: readonly string[],
): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalid(path, "Expected an object");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw invalid(path, "Expected a plain object");
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw invalid(path, "Expected string fields");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw invalid(`${path}.${key}`, "Expected an enumerable data property");
		}
		if (allowedKeys && !allowedKeys.includes(key)) {
			throw invalid(`${path}.${key}`, "Unexpected field");
		}
	}
	return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
	value: Readonly<Record<string, unknown>>,
	path: string,
	keys: readonly string[],
): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw invalid(`${path}.${key}`, "Unexpected field");
	}
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) throw invalid(`${path}.${key}`, "Missing field");
	}
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw invalid(path, "Expected a non-empty string");
	}
	return value;
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw invalid(path, "Expected a boolean");
	return value;
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function invalid(path: string, message: string): CliServiceDescriptionError {
	return new CliServiceDescriptionError(path, message);
}
