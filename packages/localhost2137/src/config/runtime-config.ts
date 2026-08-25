import { z } from "zod";
import { ConfigError, type ConfigIssue } from "./config-error.js";
import { absoluteZodIssue } from "./zod-diagnostics.js";

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

export interface ParsedRuntimeConfig {
	readonly clock: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly host: "127.0.0.1" | "localhost" | "::1";
	readonly port: number;
	readonly seed?: (...arguments_: readonly unknown[]) => unknown;
	readonly services: Readonly<Record<string, unknown>>;
	readonly storage: Readonly<{ dir: string }>;
}

export function parseRuntimeConfig(rawConfig: unknown, configPath: string): ParsedRuntimeConfig {
	const result = runtimeConfigSchema.safeParse(rawConfig);
	if (result.success) {
		return {
			clock: result.data.clock,
			host: result.data.host,
			port: result.data.port,
			...(result.data.seed ? { seed: result.data.seed } : {}),
			services: result.data.services,
			storage: result.data.storage,
		};
	}
	const issues = result.error.issues.map((issue) => absoluteZodIssue(issue, rawConfig));
	throw invalidConfig(configPath, issues);
}

export function invalidConfig(
	configPath: string,
	issues: readonly ConfigIssue[],
	causes: readonly unknown[] = [],
): ConfigError {
	const cause =
		causes.length === 0
			? undefined
			: new AggregateError(causes, `Internal causes while resolving config at ${configPath}.`);
	return new ConfigError(
		"CONFIG_INVALID",
		`Invalid localhost2137 config at ${configPath} (${issues.length} ${issues.length === 1 ? "issue" : "issues"}).`,
		{ configPath, issues },
		cause,
	);
}
