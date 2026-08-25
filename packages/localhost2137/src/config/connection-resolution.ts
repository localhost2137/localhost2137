import { type ConfigIssue, issuePath, receivedType } from "./config-error.js";
import {
	type ImmutableConfigData,
	type ImmutableConfigObject,
	ImmutableConfigDataError,
	ownImmutableConfigData,
} from "./immutable-config-data.js";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface ResolvedConnectionPreview {
	readonly env: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, ImmutableConfigData>>;
}

export interface ResolveConnectionInput {
	readonly baseUrl: string;
	readonly config: ImmutableConfigData;
	readonly exportEnv: boolean;
	readonly function: unknown;
	readonly owners: Map<string, string>;
	readonly serviceKey: string;
	readonly issues: ConfigIssue[];
	readonly causes: unknown[];
}

export function resolveConnection(
	input: ResolveConnectionInput,
): ResolvedConnectionPreview | undefined {
	let value: unknown;
	try {
		if (typeof input.function !== "function") {
			return undefined;
		}
		value = input.function({
			baseUrl: input.baseUrl,
			config: input.config,
			instanceId: "dev",
			serviceKey: input.serviceKey,
		});
	} catch (cause) {
		input.causes.push(cause);
		input.issues.push({
			code: "connection_failed",
			expected: "connection() to return metadata without throwing",
			message: `Service "${input.serviceKey}" connection() threw while resolving config.`,
			path: issuePath(["services", input.serviceKey, "$plugin", "connection"]),
			serviceKey: input.serviceKey,
		});
		return undefined;
	}

	if (!isRecord(value) || !isRecord(value.values) || !isRecord(value.env)) {
		input.issues.push({
			code: "invalid_connection_result",
			expected: "{ values: object, env: Record<string, string> }",
			message: `Service "${input.serviceKey}" connection() returned invalid metadata.`,
			path: issuePath(["services", input.serviceKey, "$plugin", "connection"]),
			received: receivedType(value),
			serviceKey: input.serviceKey,
		});
		return undefined;
	}

	const env: Record<string, string> = {};
	const ownedNames: string[] = [];
	let valid = true;
	for (const [name, entry] of Object.entries(value.env)) {
		if (!ENV_NAME_PATTERN.test(name)) {
			valid = false;
			input.issues.push({
				code: "invalid_env_name",
				expected: "^[A-Z][A-Z0-9_]*$",
				message: `Service "${input.serviceKey}" exports invalid environment name "${name}".`,
				path: issuePath(["services", input.serviceKey, "$plugin", "connection", "env", name]),
				serviceKey: input.serviceKey,
			});
		}
		if (typeof entry !== "string") {
			valid = false;
			input.issues.push({
				code: "invalid_env_value",
				expected: "string",
				message: `Service "${input.serviceKey}" environment value "${name}" must be a string.`,
				path: issuePath(["services", input.serviceKey, "$plugin", "connection", "env", name]),
				received: receivedType(entry),
				serviceKey: input.serviceKey,
			});
		} else {
			env[name] = entry;
		}

		if (input.exportEnv) {
			const owner = input.owners.get(name);
			if (owner) {
				valid = false;
				input.issues.push({
					code: "env_collision",
					expected: "unique exported environment names",
					message: `Services "${owner}" and "${input.serviceKey}" both export "${name}"; set exportEnv: false on one mount and wire it manually.`,
					path: issuePath(["services", input.serviceKey, "$plugin", "connection", "env", name]),
					serviceKey: input.serviceKey,
				});
			} else {
				ownedNames.push(name);
			}
		}
	}

	let values: ImmutableConfigData | undefined;
	try {
		values = ownImmutableConfigData(
			value.values,
			issuePath(["services", input.serviceKey, "$plugin", "connection", "values"]),
		);
	} catch (cause) {
		valid = false;
		input.causes.push(cause);
		const immutableError = cause instanceof ImmutableConfigDataError ? cause : undefined;
		input.issues.push({
			code: "connection_values_not_immutable_data",
			expected: "JSON-compatible plain data",
			message: `Service "${input.serviceKey}" connection values must be immutable plain data.`,
			path:
				immutableError?.path ??
				issuePath(["services", input.serviceKey, "$plugin", "connection", "values"]),
			...(immutableError ? { received: immutableError.received } : {}),
			serviceKey: input.serviceKey,
		});
	}

	if (!valid || !isImmutableObject(values)) {
		return undefined;
	}
	for (const name of ownedNames) {
		input.owners.set(name, input.serviceKey);
	}
	return Object.freeze({ env: Object.freeze(env), values });
}

function isImmutableObject(value: ImmutableConfigData | undefined): value is ImmutableConfigObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
