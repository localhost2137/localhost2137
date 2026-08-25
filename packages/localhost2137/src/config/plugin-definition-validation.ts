import { z } from "zod";
import type { ConfiguredServiceRuntime, RuntimePluginDefinition } from "../authoring/plugin.js";
import { type ConfigIssue, issuePath, receivedType } from "./config-error.js";
import { toCliName } from "./schema-metadata.js";

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const OPERATION_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const RESERVED_SERVICE_KEYS = new Set(["_", "clock", "destroy", "env", "idle", "reset", "seed"]);
const RESERVED_OPERATION_KEYS = new Set(["connection"]);

export function validateServiceKey(serviceKey: string, issues: ConfigIssue[]): void {
	if (RESERVED_SERVICE_KEYS.has(serviceKey)) {
		issues.push({
			code: "reserved_service_key",
			expected: "a non-reserved service key",
			message: `Service key "${serviceKey}" is reserved by the instance facade.`,
			path: issuePath(["services", serviceKey]),
			received: "reserved name",
			serviceKey,
		});
	}
	if (!SERVICE_ID_PATTERN.test(serviceKey)) {
		issues.push({
			code: "invalid_service_key",
			expected: "^[a-z][a-z0-9-]{0,62}$",
			message: `Service key "${serviceKey}" must be lowercase and URL-safe.`,
			path: issuePath(["services", serviceKey]),
			received: "invalid identifier",
			serviceKey,
		});
	}
}

export function validatePluginDefinition(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	issues: ConfigIssue[],
): void {
	const basePath = ["services", serviceKey, "$plugin"] as const;
	if (!SERVICE_ID_PATTERN.test(definition.id)) {
		issues.push({
			code: "invalid_plugin_id",
			expected: "^[a-z][a-z0-9-]{0,62}$",
			message: `Plugin id "${definition.id}" must be lowercase and URL-safe.`,
			path: issuePath([...basePath, "id"]),
			received: "invalid identifier",
			serviceKey,
		});
	}
	if (typeof definition.description !== "string" || definition.description.trim() === "") {
		issues.push({
			code: "invalid_plugin_description",
			expected: "a non-empty string",
			message: `Plugin "${definition.id}" must declare a description.`,
			path: issuePath([...basePath, "description"]),
			received: receivedType(definition.description),
			serviceKey,
		});
	}
	if (!Number.isInteger(definition.stateVersion) || Number(definition.stateVersion) < 1) {
		issues.push({
			code: "invalid_state_version",
			expected: "a positive integer",
			message: `Plugin "${definition.id}" stateVersion must be a positive integer.`,
			path: issuePath([...basePath, "stateVersion"]),
			received: receivedType(definition.stateVersion),
			serviceKey,
		});
	}
	if (!hasFunction(definition.api, "fetch")) {
		issues.push({
			code: "invalid_hono_app",
			expected: "a Hono app with a fetch() method",
			message: `Plugin "${definition.id}" api must be a Hono app.`,
			path: issuePath([...basePath, "api"]),
			received: receivedType(definition.api),
			serviceKey,
		});
	}
	if (typeof definition.connection !== "function") {
		issues.push({
			code: "invalid_connection",
			expected: "a connection metadata function",
			message: `Plugin "${definition.id}" must declare connection().`,
			path: issuePath([...basePath, "connection"]),
			received: receivedType(definition.connection),
			serviceKey,
		});
	}

	validateLifecycle(serviceKey, definition, issues);
}

/** Returns whether operation metadata can be inspected without touching malformed entries. */
export function validateOperationDefinitions(
	serviceKey: string,
	operations: unknown,
	issues: ConfigIssue[],
): boolean {
	return validateOperations(serviceKey, operations, issues);
}

export function validateEnvelopeKeys(
	serviceKey: string,
	envelope: ConfiguredServiceRuntime["envelope"],
	issues: ConfigIssue[],
): void {
	const allowed = new Set(["config", "exportEnv", "seed"]);
	for (const key of Object.keys(envelope)) {
		if (!allowed.has(key)) {
			issues.push({
				code: "unknown_envelope_key",
				expected: "config, seed, or exportEnv",
				message: `Service "${serviceKey}" envelope contains unknown key "${key}".`,
				path: issuePath(["services", serviceKey, key]),
				serviceKey,
			});
		}
	}
}

function validateLifecycle(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	issues: ConfigIssue[],
): void {
	const lifecycle = definition.lifecycle;
	const basePath = ["services", serviceKey, "$plugin", "lifecycle"] as const;
	for (const hook of ["create", "start"] as const) {
		if (!hasFunction(lifecycle, hook)) {
			issues.push(lifecycleHookIssue(definition.id, serviceKey, basePath, hook, lifecycle, true));
		}
	}
	for (const hook of ["stop", "update"] as const) {
		if (hasOwn(lifecycle, hook) && !hasFunction(lifecycle, hook)) {
			issues.push(lifecycleHookIssue(definition.id, serviceKey, basePath, hook, lifecycle, false));
		}
	}

	const seedHookPresent = hasOwn(lifecycle, "seed");
	const seedHookCallable = hasFunction(lifecycle, "seed");
	const seedSchemaPresent = definition.seedSchema !== undefined;
	if (seedHookPresent && !seedHookCallable) {
		issues.push(lifecycleHookIssue(definition.id, serviceKey, basePath, "seed", lifecycle, false));
	}
	if (seedHookPresent !== seedSchemaPresent) {
		issues.push({
			code: "seed_contract_mismatch",
			expected: "seedSchema and lifecycle.seed to either both exist or both be absent",
			message: `Plugin "${definition.id}" must pair seedSchema with lifecycle.seed.`,
			path: issuePath(["services", serviceKey, "$plugin", "seedSchema"]),
			serviceKey,
		});
	}
}

function lifecycleHookIssue(
	pluginId: string,
	serviceKey: string,
	basePath: readonly PropertyKey[],
	hook: string,
	lifecycle: object,
	required: boolean,
): ConfigIssue {
	return {
		code: required ? "missing_lifecycle_hook" : "invalid_lifecycle_hook",
		expected: "a function",
		message: required
			? `Plugin "${pluginId}" lifecycle.${hook} is required.`
			: `Plugin "${pluginId}" lifecycle.${hook} must be a function when present.`,
		path: issuePath([...basePath, hook]),
		received: receivedType(readProperty(lifecycle, hook)),
		serviceKey,
	};
}

function validateOperations(
	serviceKey: string,
	operations: unknown,
	issues: ConfigIssue[],
): boolean {
	const operationsPath = ["services", serviceKey, "$plugin", "operations"] as const;
	if (!isPlainRecord(operations)) {
		issues.push({
			code: "invalid_operations",
			expected: "an object mapping operation names to operation definitions",
			message: `Service "${serviceKey}" operations must be an object record.`,
			path: issuePath(operationsPath),
			received: receivedType(operations),
			serviceKey,
		});
		return false;
	}

	const cliOwners = new Map<string, string>();
	let structurallyValid = true;
	for (const [operationKey, operation] of Object.entries(operations)) {
		const path = [...operationsPath, operationKey] as const;
		if (!isPlainRecord(operation)) {
			structurallyValid = false;
			issues.push({
				code: "invalid_operation_definition",
				expected: "an operation definition object",
				message: `Operation "${operationKey}" must be an operation definition object.`,
				path: issuePath(path),
				received: receivedType(operation),
				serviceKey,
			});
			continue;
		}
		if (RESERVED_OPERATION_KEYS.has(operationKey)) {
			issues.push({
				code: "reserved_operation_key",
				expected: "a non-reserved operation key",
				message: `Operation key "${operationKey}" is reserved for connection metadata.`,
				path: issuePath(path),
				received: "reserved name",
				serviceKey,
			});
		}
		if (!OPERATION_KEY_PATTERN.test(operationKey)) {
			issues.push({
				code: "invalid_operation_key",
				expected: "a camelCase JavaScript identifier",
				message: `Operation key "${operationKey}" must be a camelCase JavaScript identifier.`,
				path: issuePath(path),
				received: "invalid identifier",
				serviceKey,
			});
		}
		const cliName = toCliName(operationKey);
		const owner = cliOwners.get(cliName);
		if (owner) {
			issues.push({
				code: "operation_cli_collision",
				expected: "unique kebab-case CLI names",
				message: `Operations "${owner}" and "${operationKey}" both map to CLI name "${cliName}".`,
				path: issuePath(path),
				serviceKey,
			});
		} else {
			cliOwners.set(cliName, operationKey);
		}
		if (typeof operation.run !== "function") {
			issues.push({
				code: "invalid_operation_run",
				expected: "a function",
				message: `Operation "${operationKey}" must declare run().`,
				path: issuePath([...path, "run"]),
				received: receivedType(operation.run),
				serviceKey,
			});
		}
		if (typeof operation.description !== "string" || operation.description.trim() === "") {
			issues.push({
				code: "invalid_operation_description",
				expected: "a non-empty string",
				message: `Operation "${operationKey}" must declare a description.`,
				path: issuePath([...path, "description"]),
				received: receivedType(operation.description),
				serviceKey,
			});
		}
		// Zod is a required peer of both host and plugin packages. instanceof is
		// the public, non-forgeable ZodObject boundary; packed-consumer tests
		// verify the peer layout keeps this constructor identity shared.
		if (!(operation.input instanceof z.ZodObject)) {
			issues.push({
				code: "operation_input_not_zod_object",
				expected: "a ZodObject created with z.object()",
				message: `Operation "${operationKey}" input must be a Zod object schema.`,
				path: issuePath([...path, "input"]),
				received: receivedType(operation.input),
				serviceKey,
			});
		}
	}
	return structurallyValid;
}

function hasOwn(value: unknown, key: PropertyKey): boolean {
	return isRecordOrFunction(value) && Object.hasOwn(value, key);
}

function hasFunction(value: unknown, key: PropertyKey): boolean {
	return isRecordOrFunction(value) && typeof value[key] === "function";
}

function readProperty(value: unknown, key: PropertyKey): unknown {
	return isRecordOrFunction(value) ? value[key] : undefined;
}

function isRecordOrFunction(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
