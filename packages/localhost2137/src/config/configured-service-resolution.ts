import type { ConfiguredServiceRuntime, RuntimePluginDefinition } from "../authoring/plugin.js";
import { resolveConnection, type ResolvedConnectionPreview } from "./connection-resolution.js";
import { type ConfigIssue, issuePath, receivedType } from "./config-error.js";
import {
	type ImmutableConfigData,
	ImmutableConfigDataError,
	ownImmutableConfigData,
} from "./immutable-config-data.js";
import {
	validateEnvelopeKeys,
	validateOperationDefinitions,
	validatePluginDefinition,
} from "./plugin-definition-validation.js";
import {
	resolveServiceSchemaMetadata,
	type ServiceSchemaMetadata,
} from "./service-schema-metadata.js";
import type { JsonObject, OperationMetadata } from "./schema-metadata.js";
import { parsePluginSchema, type RelativeConfigIssue } from "./zod-diagnostics.js";

export interface ResolvedServiceConfig {
	readonly config: ImmutableConfigData;
	readonly configSchema: JsonObject;
	readonly connection: ResolvedConnectionPreview;
	readonly exportEnv: boolean;
	readonly operations: Readonly<Record<string, OperationMetadata>>;
	readonly plugin: RuntimePluginDefinition;
	readonly pluginId: string;
	readonly seed?: ImmutableConfigData;
	readonly seedSchema?: JsonObject;
	readonly serviceKey: string;
	readonly stateVersion: number;
}

export interface ResolveConfiguredServiceInput {
	readonly baseUrl: string;
	readonly descriptor: ConfiguredServiceRuntime;
	readonly environmentOwners: Map<string, string>;
	readonly issues: ConfigIssue[];
	readonly causes: unknown[];
	readonly serviceKey: string;
}

export function resolveConfiguredService(
	input: ResolveConfiguredServiceInput,
): ResolvedServiceConfig | undefined {
	const { definition, envelope } = input.descriptor;
	const issueCountBefore = input.issues.length;
	validateEnvelopeKeys(input.serviceKey, envelope, input.issues);
	validatePluginDefinition(input.serviceKey, definition, input.issues);
	const operationsAreStructurallyValid = validateOperationDefinitions(
		input.serviceKey,
		definition.operations,
		input.issues,
	);

	const parsedConfig = parsePluginSchema(definition.configSchema, envelope.config);
	if (!parsedConfig.success) {
		appendParseIssues(input.serviceKey, "config", parsedConfig.issues, input.issues);
		if (parsedConfig.cause) input.causes.push(parsedConfig.cause);
	}
	const ownedConfig = parsedConfig.success
		? ownParsedData(parsedConfig.data, ["services", input.serviceKey, "config"], input)
		: undefined;

	const exportEnv = envelope.exportEnv === undefined ? true : envelope.exportEnv;
	if (typeof exportEnv !== "boolean") {
		input.issues.push({
			code: "invalid_type",
			expected: "boolean",
			message: `Service "${input.serviceKey}" exportEnv must be a boolean.`,
			path: issuePath(["services", input.serviceKey, "exportEnv"]),
			received: receivedType(envelope.exportEnv),
			serviceKey: input.serviceKey,
		});
	}

	const seed = resolveSeed(input, definition, envelope);
	const metadata = operationsAreStructurallyValid
		? resolveServiceSchemaMetadata(input.serviceKey, definition, input.issues, input.causes)
		: undefined;
	const connection =
		ownedConfig !== undefined && typeof definition.connection === "function"
			? resolveConnection({
					baseUrl: input.baseUrl,
					causes: input.causes,
					config: ownedConfig,
					exportEnv: exportEnv === true,
					function: definition.connection,
					issues: input.issues,
					owners: input.environmentOwners,
					serviceKey: input.serviceKey,
				})
			: undefined;

	if (
		input.issues.length > issueCountBefore ||
		ownedConfig === undefined ||
		seed.success === false ||
		!metadata ||
		!connection ||
		typeof exportEnv !== "boolean" ||
		typeof definition.stateVersion !== "number"
	) {
		return undefined;
	}

	return createResolvedService(
		input.serviceKey,
		definition,
		ownedConfig,
		exportEnv,
		seed,
		metadata,
		connection,
		definition.stateVersion,
	);
}

type SeedResolution =
	| Readonly<{ present: false; success: true }>
	| Readonly<{ data: ImmutableConfigData; present: true; success: true }>
	| Readonly<{ success: false }>;

function resolveSeed(
	input: ResolveConfiguredServiceInput,
	definition: RuntimePluginDefinition,
	envelope: ConfiguredServiceRuntime["envelope"],
): SeedResolution {
	const hasSeed = Object.hasOwn(envelope, "seed");
	if (!definition.seedSchema) {
		if (hasSeed) {
			input.issues.push({
				code: "seed_not_supported",
				expected: "no seed field",
				message: `Service "${input.serviceKey}" configures seed data but its plugin has no seedSchema.`,
				path: issuePath(["services", input.serviceKey, "seed"]),
				serviceKey: input.serviceKey,
			});
			return { success: false };
		}
		return { present: false, success: true };
	}
	if (!hasSeed) return { present: false, success: true };

	const parsed = parsePluginSchema(definition.seedSchema, envelope.seed);
	if (!parsed.success) {
		appendParseIssues(input.serviceKey, "seed", parsed.issues, input.issues);
		if (parsed.cause) input.causes.push(parsed.cause);
		return { success: false };
	}
	const data = ownParsedData(parsed.data, ["services", input.serviceKey, "seed"], input);
	return data !== undefined ? { data, present: true, success: true } : { success: false };
}

function ownParsedData(
	value: unknown,
	path: readonly PropertyKey[],
	input: ResolveConfiguredServiceInput,
): ImmutableConfigData | undefined {
	try {
		return ownImmutableConfigData(value, issuePath(path));
	} catch (cause) {
		input.causes.push(cause);
		const immutableError = cause instanceof ImmutableConfigDataError ? cause : undefined;
		input.issues.push({
			code: "parsed_data_not_immutable",
			expected: "JSON-compatible plain data",
			message: `Service "${input.serviceKey}" parsed data must be immutable plain data.`,
			path: immutableError?.path ?? issuePath(path),
			...(immutableError ? { received: immutableError.received } : {}),
			serviceKey: input.serviceKey,
		});
		return undefined;
	}
}

function appendParseIssues(
	serviceKey: string,
	field: "config" | "seed",
	relativeIssues: readonly RelativeConfigIssue[],
	issues: ConfigIssue[],
): void {
	for (const issue of relativeIssues) {
		const { relativePath, ...diagnostic } = issue;
		issues.push({
			...diagnostic,
			path: issuePath(["services", serviceKey, field, ...relativePath]),
			serviceKey,
		});
	}
}

function createResolvedService(
	serviceKey: string,
	definition: RuntimePluginDefinition,
	config: ImmutableConfigData,
	exportEnv: boolean,
	seed: Exclude<SeedResolution, { success: false }>,
	metadata: ServiceSchemaMetadata,
	connection: ResolvedConnectionPreview,
	stateVersion: number,
): ResolvedServiceConfig {
	return Object.freeze({
		config,
		configSchema: metadata.config,
		connection,
		exportEnv,
		operations: metadata.operations,
		plugin: definition,
		pluginId: definition.id,
		...(seed.present ? { seed: seed.data } : {}),
		...(metadata.seed ? { seedSchema: metadata.seed } : {}),
		serviceKey,
		stateVersion,
	});
}
