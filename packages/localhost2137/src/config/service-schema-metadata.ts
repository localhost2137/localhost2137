import type { RuntimePluginDefinition } from "../authoring/plugin.js";
import { type ConfigIssue, issuePath } from "./config-error.js";
import {
	createOperationMetadata,
	createSchemaMetadata,
	type JsonObject,
	type OperationMetadata,
	SchemaIntrospectionError,
} from "./schema-metadata.js";

export interface ServiceSchemaMetadata {
	readonly config: JsonObject;
	readonly operations: Readonly<Record<string, OperationMetadata>>;
	readonly seed?: JsonObject;
}

export function resolveServiceSchemaMetadata(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	issues: ConfigIssue[],
	causes: unknown[],
	inspectOperations: boolean,
): ServiceSchemaMetadata | undefined {
	let config: JsonObject | undefined;
	let seed: JsonObject | undefined;
	let valid = true;
	try {
		config = createSchemaMetadata(definition.configSchema, "config", "input");
	} catch (cause) {
		valid = false;
		causes.push(cause);
		issues.push({
			code: "schema_introspection_failed",
			expected: "a Zod schema representable as JSON Schema",
			message: `Service "${serviceKey}" config schema cannot be introspected.`,
			path: issuePath(["services", serviceKey, "$plugin", "configSchema"]),
			serviceKey,
		});
	}
	if (definition.seedSchema) {
		try {
			seed = createSchemaMetadata(definition.seedSchema, "seed", "input");
		} catch (cause) {
			valid = false;
			causes.push(cause);
			issues.push({
				code: "schema_introspection_failed",
				expected: "a Zod schema representable as JSON Schema",
				message: `Service "${serviceKey}" seed schema cannot be introspected.`,
				path: issuePath(["services", serviceKey, "$plugin", "seedSchema"]),
				serviceKey,
			});
		}
	}

	const operations: Record<string, OperationMetadata> = {};
	const operationEntries = inspectOperations ? Object.entries(definition.operations) : [];
	for (const [operationKey, operation] of operationEntries) {
		try {
			operations[operationKey] = createOperationMetadata(operation);
		} catch (cause) {
			valid = false;
			causes.push(cause);
			const role = cause instanceof SchemaIntrospectionError ? cause.schemaRole : "input";
			issues.push({
				code: "schema_introspection_failed",
				expected: "a Zod schema representable as JSON Schema",
				message: `Operation "${operationKey}" ${role} schema cannot be introspected.`,
				path: issuePath(["services", serviceKey, "$plugin", "operations", operationKey, role]),
				serviceKey,
			});
		}
	}

	return valid && config
		? Object.freeze({
				config,
				operations: Object.freeze(operations),
				...(seed ? { seed } : {}),
			})
		: undefined;
}
