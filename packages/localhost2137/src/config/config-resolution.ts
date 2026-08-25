import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
	readConfiguredService,
	type ConfiguredServiceRuntime,
	type RuntimePluginDefinition,
	type RuntimeOperationDefinition,
} from "../authoring/plugin.js";
import type { Schema } from "../authoring/operation.js";
import { ConfigError, type ConfigIssue, issuePath, receivedType } from "./config-error.js";
import { createConfigFingerprint } from "./config-fingerprint.js";
import {
	createOperationMetadata,
	createSchemaMetadata,
	type JsonObject,
	type OperationMetadata,
	SchemaIntrospectionError,
	toCliName,
} from "./schema-metadata.js";

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const OPERATION_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_SERVICE_KEYS = new Set(["_", "clock", "destroy", "env", "idle", "reset", "seed"]);
const RESERVED_OPERATION_KEYS = new Set(["connection"]);

const clockSchema = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("real") }),
	z.strictObject({
		mode: z.literal("pinned"),
		startAt: z.iso.datetime({ offset: true }),
	}),
]);

const runtimeConfigSchema = z.strictObject({
	clock: clockSchema.default({ mode: "real" }),
	host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
	port: z.int().min(1).max(65_535).default(2137),
	seed: z
		.custom<(...arguments_: readonly unknown[]) => unknown>(
			(value) => typeof value === "function",
			"Expected a scenario seed function.",
		)
		.optional(),
	services: z.record(z.string(), z.unknown()),
	storage: z.strictObject({ dir: z.string().trim().min(1) }).default({ dir: ".localhost2137" }),
});

interface ResolvedConnectionPreview {
	readonly env: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, unknown>>;
}

interface ResolvedServiceConfig {
	readonly config: unknown;
	readonly configSchema: JsonObject;
	readonly connection: ResolvedConnectionPreview;
	readonly exportEnv: boolean;
	readonly operations: Readonly<Record<string, OperationMetadata>>;
	readonly plugin: RuntimePluginDefinition;
	readonly pluginId: string;
	readonly seed?: unknown;
	readonly seedSchema?: JsonObject;
	readonly serviceKey: string;
	readonly stateVersion: number;
}

export interface ResolvedConfig {
	readonly clock: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly configDirectory: string;
	readonly configPath: string;
	readonly fingerprint: string;
	readonly host: "127.0.0.1" | "localhost" | "::1";
	readonly port: number;
	readonly seed?: (...arguments_: readonly unknown[]) => unknown;
	readonly services: Readonly<Record<string, ResolvedServiceConfig>>;
	readonly storage: Readonly<{ dir: string }>;
}

export interface PathSemantics {
	dirname(path: string): string;
	resolve(...paths: string[]): string;
}

export function resolvePathFromConfig(
	configPath: string,
	configuredPath: string,
	pathSemantics: PathSemantics = { dirname, resolve },
): string {
	return pathSemantics.resolve(pathSemantics.dirname(configPath), configuredPath);
}

export function resolveConfig(rawConfig: unknown, configPath: string): ResolvedConfig {
	const runtimeResult = runtimeConfigSchema.safeParse(rawConfig);
	if (!runtimeResult.success) {
		throw invalidConfig(
			configPath,
			runtimeResult.error.issues.map((issue) => zodIssue(issue, rawConfig)),
		);
	}

	const issues: ConfigIssue[] = [];
	const services: Record<string, ResolvedServiceConfig> = {};
	const environmentOwners = new Map<string, string>();
	const baseUrl = formatBaseUrl(runtimeResult.data.host, runtimeResult.data.port);

	for (const [serviceKey, configuredValue] of Object.entries(runtimeResult.data.services)) {
		const descriptor = readConfiguredService(configuredValue);
		if (!descriptor) {
			issues.push({
				code: "service_descriptor",
				expected: "a value returned by a definePlugin factory",
				message: `Service "${serviceKey}" is not a configured plugin descriptor.`,
				path: issuePath(["services", serviceKey]),
				received: receivedType(configuredValue),
				serviceKey,
			});
			continue;
		}

		validateServiceKey(serviceKey, issues);
		const resolvedService = resolveService({
			baseUrl,
			configPath,
			descriptor,
			environmentOwners,
			issues,
			serviceKey,
		});
		if (resolvedService) {
			services[serviceKey] = resolvedService;
		}
	}

	if (issues.length > 0) {
		throw invalidConfig(configPath, issues);
	}

	const storageDirectory = resolvePathFromConfig(configPath, runtimeResult.data.storage.dir);
	const immutableServices = Object.freeze({ ...services });
	const fingerprint = createConfigFingerprint({
		clock: runtimeResult.data.clock,
		host: runtimeResult.data.host,
		port: runtimeResult.data.port,
		services: Object.fromEntries(
			Object.entries(immutableServices).map(([key, service]) => [
				key,
				{
					config: service.config,
					exportEnv: service.exportEnv,
					operations: Object.keys(service.operations),
					pluginId: service.pluginId,
					seed: service.seed,
					stateVersion: service.stateVersion,
				},
			]),
		),
		storageDirectory,
	});
	const clock = freezePlain(runtimeResult.data.clock);

	return Object.freeze({
		clock,
		configDirectory: dirname(configPath),
		configPath,
		fingerprint,
		host: runtimeResult.data.host,
		port: runtimeResult.data.port,
		...(runtimeResult.data.seed ? { seed: runtimeResult.data.seed } : {}),
		services: immutableServices,
		storage: Object.freeze({ dir: storageDirectory }),
	});
}

interface ResolveServiceInput {
	readonly baseUrl: string;
	readonly configPath: string;
	readonly descriptor: ConfiguredServiceRuntime;
	readonly environmentOwners: Map<string, string>;
	readonly issues: ConfigIssue[];
	readonly serviceKey: string;
}

function resolveService(input: ResolveServiceInput): ResolvedServiceConfig | undefined {
	const { definition, envelope } = input.descriptor;
	const path = ["services", input.serviceKey] as const;
	const issueCountBefore = input.issues.length;
	validateEnvelopeKeys(input.serviceKey, envelope, input.issues);
	validatePluginDefinition(input.serviceKey, definition, input.issues);
	validateOperations(input.serviceKey, definition.operations, input.issues);

	const configResult = safeParseSchema(definition.configSchema, envelope.config);
	if (!configResult.success) {
		for (const issue of configResult.issues) {
			const { relativePath, ...diagnostic } = issue;
			input.issues.push({
				...diagnostic,
				path: issuePath([...path, "config", ...relativePath]),
				serviceKey: input.serviceKey,
			});
		}
	}

	const exportEnv = envelope.exportEnv === undefined ? true : envelope.exportEnv;
	if (typeof exportEnv !== "boolean") {
		input.issues.push({
			code: "invalid_type",
			expected: "boolean",
			message: `Service "${input.serviceKey}" exportEnv must be a boolean.`,
			path: issuePath([...path, "exportEnv"]),
			received: receivedType(envelope.exportEnv),
			serviceKey: input.serviceKey,
		});
	}

	const seedResult = resolveSeed(input.serviceKey, definition, envelope, input.issues);
	const metadata = resolveServiceMetadata(input.serviceKey, definition, input.issues);
	const connection =
		configResult.success && typeof definition.connection === "function"
			? resolveConnection({
					baseUrl: input.baseUrl,
					config: configResult.data,
					exportEnv: exportEnv === true,
					function: definition.connection,
					owners: input.environmentOwners,
					serviceKey: input.serviceKey,
					issues: input.issues,
				})
			: undefined;

	if (
		input.issues.length > issueCountBefore ||
		!configResult.success ||
		!seedResult.success ||
		!metadata ||
		!connection ||
		typeof exportEnv !== "boolean" ||
		typeof definition.stateVersion !== "number"
	) {
		return undefined;
	}

	const config = freezeConfigData(configResult.data);
	const seed = seedResult.present ? freezeConfigData(seedResult.data) : undefined;
	return Object.freeze({
		config,
		configSchema: metadata.config,
		connection,
		exportEnv,
		operations: metadata.operations,
		plugin: definition,
		pluginId: definition.id,
		...(seedResult.present ? { seed } : {}),
		...(metadata.seed ? { seedSchema: metadata.seed } : {}),
		serviceKey: input.serviceKey,
		stateVersion: definition.stateVersion,
	});
}

function validateServiceKey(serviceKey: string, issues: ConfigIssue[]): void {
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

function validatePluginDefinition(
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

	const lifecycle = definition.lifecycle;
	for (const hook of ["create", "start"] as const) {
		if (!hasFunction(lifecycle, hook)) {
			issues.push({
				code: "missing_lifecycle_hook",
				expected: "a function",
				message: `Plugin "${definition.id}" lifecycle.${hook} is required.`,
				path: issuePath([...basePath, "lifecycle", hook]),
				received: receivedType(readProperty(lifecycle, hook)),
				serviceKey,
			});
		}
	}
	const seedHook = hasFunction(lifecycle, "seed");
	const seedSchema = definition.seedSchema !== undefined;
	if (seedHook !== seedSchema) {
		issues.push({
			code: "seed_contract_mismatch",
			expected: "seedSchema and lifecycle.seed to either both exist or both be absent",
			message: `Plugin "${definition.id}" must pair seedSchema with lifecycle.seed.`,
			path: issuePath([...basePath, "seedSchema"]),
			serviceKey,
		});
	}
}

function validateEnvelopeKeys(
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

function validateOperations(
	serviceKey: string,
	operations: Readonly<Record<string, RuntimeOperationDefinition>>,
	issues: ConfigIssue[],
): void {
	const cliOwners = new Map<string, string>();
	for (const [operationKey, operation] of Object.entries(operations)) {
		const path = ["services", serviceKey, "$plugin", "operations", operationKey] as const;
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
	}
}

type SeedResolution =
	| Readonly<{ data?: undefined; present: false; success: true }>
	| Readonly<{ data: unknown; present: true; success: true }>
	| Readonly<{ success: false }>;

function resolveSeed(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	envelope: ConfiguredServiceRuntime["envelope"],
	issues: ConfigIssue[],
): SeedResolution {
	const hasSeed = Object.hasOwn(envelope, "seed");
	if (!definition.seedSchema) {
		if (hasSeed) {
			issues.push({
				code: "seed_not_supported",
				expected: "no seed field",
				message: `Service "${serviceKey}" configures seed data but its plugin has no seedSchema.`,
				path: issuePath(["services", serviceKey, "seed"]),
				serviceKey,
			});
			return { success: false };
		}
		return { present: false, success: true };
	}
	if (!hasSeed) {
		return { present: false, success: true };
	}

	const result = safeParseSchema(definition.seedSchema, envelope.seed);
	if (!result.success) {
		for (const issue of result.issues) {
			const { relativePath, ...diagnostic } = issue;
			issues.push({
				...diagnostic,
				path: issuePath(["services", serviceKey, "seed", ...relativePath]),
				serviceKey,
			});
		}
		return { success: false };
	}
	return { data: result.data, present: true, success: true };
}

interface ServiceMetadata {
	readonly config: JsonObject;
	readonly operations: Readonly<Record<string, OperationMetadata>>;
	readonly seed?: JsonObject;
}

function resolveServiceMetadata(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	issues: ConfigIssue[],
): ServiceMetadata | undefined {
	let config: JsonObject | undefined;
	let seed: JsonObject | undefined;
	let valid = true;
	try {
		config = createSchemaMetadata(definition.configSchema, "config");
	} catch {
		valid = false;
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
			seed = createSchemaMetadata(definition.seedSchema, "seed");
		} catch {
			valid = false;
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
	for (const [operationKey, operation] of Object.entries(definition.operations)) {
		try {
			const operationMetadata = createOperationMetadata(operation);
			if (operationMetadata.input.type !== "object") {
				valid = false;
				issues.push({
					code: "operation_input_not_object",
					expected: "a Zod object schema",
					message: `Operation "${operationKey}" input must be a Zod object schema.`,
					path: issuePath(["services", serviceKey, "$plugin", "operations", operationKey, "input"]),
					serviceKey,
				});
			}
			operations[operationKey] = operationMetadata;
		} catch (cause) {
			valid = false;
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

interface ResolveConnectionInput {
	readonly baseUrl: string;
	readonly config: unknown;
	readonly exportEnv: boolean;
	readonly function: unknown;
	readonly owners: Map<string, string>;
	readonly serviceKey: string;
	readonly issues: ConfigIssue[];
}

function resolveConnection(input: ResolveConnectionInput): ResolvedConnectionPreview | undefined {
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
	} catch {
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

	if (!valid) {
		return undefined;
	}
	for (const name of ownedNames) {
		input.owners.set(name, input.serviceKey);
	}
	return Object.freeze({
		env: Object.freeze(env),
		values: freezeRecordData(value.values),
	});
}

type ParseResult =
	| Readonly<{ data: unknown; success: true }>
	| Readonly<{ issues: readonly RelativeIssue[]; success: false }>;

interface RelativeIssue extends Omit<ConfigIssue, "path"> {
	readonly relativePath: readonly PropertyKey[];
}

function safeParseSchema(schema: Schema, value: unknown): ParseResult {
	try {
		const result = schema.safeParse(value);
		if (result.success) {
			return { data: result.data, success: true };
		}
		return {
			issues: result.error.issues.map((issue) => {
				const expected = expectedFromZodIssue(issue);
				return {
					code: issue.code,
					...(expected ? { expected } : {}),
					message: issue.message,
					received: receivedType(valueAtPath(value, issue.path)),
					relativePath: issue.path,
				};
			}),
			success: false,
		};
	} catch {
		return {
			issues: [
				{
					code: "invalid_schema",
					expected: "a Zod schema",
					message: "Plugin schema could not parse the configured value.",
					received: receivedType(value),
					relativePath: [],
				},
			],
			success: false,
		};
	}
}

function zodIssue(issue: z.core.$ZodIssue, value: unknown): ConfigIssue {
	const expected = expectedFromZodIssue(issue);
	return {
		code: issue.code,
		...(expected ? { expected } : {}),
		message: issue.message,
		path: issuePath(issue.path),
		received: receivedType(valueAtPath(value, issue.path)),
	};
}

function expectedFromZodIssue(issue: z.core.$ZodIssue): string | undefined {
	if ("expected" in issue && typeof issue.expected === "string") {
		return issue.expected;
	}
	if ("format" in issue && typeof issue.format === "string") {
		return issue.format;
	}
	return undefined;
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
	let current = value;
	for (const segment of path) {
		if (!isRecordOrArray(current) || !(segment in current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function invalidConfig(configPath: string, issues: readonly ConfigIssue[]): ConfigError {
	return new ConfigError(
		"CONFIG_INVALID",
		`Invalid localhost2137 config at ${configPath} (${issues.length} ${issues.length === 1 ? "issue" : "issues"}).`,
		{ configPath, issues },
	);
}

function formatBaseUrl(host: "127.0.0.1" | "localhost" | "::1", port: number): string {
	return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}

function hasFunction(value: unknown, key: PropertyKey): boolean {
	return isRecordOrFunction(value) && typeof value[key] === "function";
}

function readProperty(value: unknown, key: PropertyKey): unknown {
	return isRecordOrFunction(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOrArray(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null;
}

function isRecordOrFunction(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

function freezeConfigData(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const entry of value) {
			freezeConfigData(entry);
		}
		return Object.freeze(value);
	}
	if (isPlainRecord(value)) {
		for (const entry of Object.values(value)) {
			freezeConfigData(entry);
		}
		return Object.freeze(value);
	}
	return value;
}

function freezeRecordData(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	for (const entry of Object.values(value)) {
		freezeConfigData(entry);
	}
	return Object.freeze(value);
}

function freezePlain<Value extends Readonly<Record<string, unknown>>>(value: Value): Value {
	return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (!isRecord(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
