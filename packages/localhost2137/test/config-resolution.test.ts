import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, definePlugin, type PluginEnv } from "../src/authoring/index.js";
import { ConfigError } from "../src/config/config-error.js";
import { resolveConfig } from "../src/config/config-resolution.js";
import { redact } from "../src/config/redaction.js";
import { untypedConfiguredService } from "./fixtures/untyped-service.js";

interface FixtureOptions {
	readonly connectionName?: string;
	readonly id?: string;
	readonly nestedInput?: boolean;
	readonly operationKeys?: readonly string[];
	readonly observeConfig?: (config: unknown) => void;
	readonly stateVersion?: number;
}

const configPath = "/workspace/project/localhost.config.ts";

function fixturePlugin(options: FixtureOptions = {}) {
	const id = options.id ?? "fixture";
	type Config = { readonly nested: { readonly enabled: boolean }; readonly token: string };
	type State = { readonly ready: true };
	const bind = defineOperation<typeof id, State, Config>();
	const operations = Object.fromEntries(
		(options.operationKeys ?? ["createThing"]).map((key) => [
			key,
			bind({
				description: `Run ${key}`,
				input: options.nestedInput
					? z.object({ nested: z.object({ value: z.string() }) })
					: z.object({ name: z.string() }),
				output: z.object({ ok: z.boolean() }),
				run: () => ({ ok: true }),
			}),
		]),
	);
	const api = new Hono<PluginEnv<State, Config>>();
	return definePlugin({
		api,
		configSchema: z.object({
			nested: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
			token: z.string().startsWith("local-"),
		}),
		connection: ({ config }) => {
			options.observeConfig?.(config);
			return {
				env: { [options.connectionName ?? "FIXTURE_TOKEN"]: config.token },
				values: { credentials: { token: config.token } },
			};
		},
		description: "Resolver fixture",
		id,
		lifecycle: {
			create: () => undefined,
			start: (): State => ({ ready: true }),
		},
		operations,
		stateVersion: options.stateVersion ?? 1,
	});
}

describe("config resolution", () => {
	it("groups top-level runtime field failures with stable paths", () => {
		expect(() =>
			resolveConfig(
				{
					clock: { mode: "real", startAt: "2026-01-01T00:00:00.000Z" },
					port: 0,
					services: {},
					unexpected: true,
				},
				configPath,
			),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				code: "CONFIG_INVALID",
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({ code: "too_small", path: "$.port" }),
						expect.objectContaining({ code: "unrecognized_keys", path: "$" }),
						expect.objectContaining({ code: "unrecognized_keys", path: "$.clock" }),
					]),
				}),
			}),
		);
	});

	it("rejects values that did not come from a plugin factory", () => {
		expect(() => resolveConfig({ services: { fixture: { config: {} } } }, configPath)).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: [
						expect.objectContaining({
							code: "service_descriptor",
							path: "$.services.fixture",
						}),
					],
				}),
			}),
		);
	});

	it("normalizes and deeply freezes runtime-owned and parsed data", () => {
		const plugin = fixturePlugin({ nestedInput: true });
		const resolved = resolveConfig(
			{
				services: {
					fixture: plugin({ config: { nested: { enabled: false }, token: "local-token" } }),
				},
				storage: { dir: "runtime-state" },
			},
			configPath,
		);

		expect(resolved.storage.dir).toBe("/workspace/project/runtime-state");
		expect(resolved.services.fixture?.operations.createThing?.cli).toEqual({
			kind: "json",
			reason: 'Field "nested" is not a supported scalar.',
		});
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.services)).toBe(true);
		expect(Object.isFrozen(resolved.services.fixture?.config)).toBe(true);
		const serviceConfig = resolved.services.fixture?.config;
		expect(isRecord(serviceConfig) && Object.isFrozen(serviceConfig.nested)).toBe(true);
		expect(Object.isFrozen(resolved.services.fixture?.connection.values.credentials)).toBe(true);
		expect(Object.isFrozen(resolved.services.fixture?.plugin.api)).toBe(false);
		expect(resolved.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("owns and freezes parsed config before any plugin callback receives it", () => {
		const observations: boolean[] = [];
		const plugin = fixturePlugin({
			observeConfig(value) {
				if (!isRecord(value) || !isRecord(value.nested)) return;
				observations.push(value.nested.enabled === true);
				expect(Reflect.set(value.nested, "enabled", false)).toBe(false);
			},
		});
		const firstInput = { nested: { enabled: true }, token: "local-first" };
		const secondInput = { nested: { enabled: true }, token: "local-second" };
		const resolved = resolveConfig(
			{
				services: {
					first: plugin({ config: firstInput }),
					second: plugin({ config: secondInput, exportEnv: false }),
				},
			},
			configPath,
		);

		expect(observations).toEqual([true, true]);
		expect(isRecord(resolved.services.first?.config)).toBe(true);
		expect(firstInput.nested.enabled).toBe(true);
		expect(secondInput.nested.enabled).toBe(true);
	});

	it("rejects mutable non-plain Zod outputs with an actionable invariant", () => {
		type State = { readonly ready: true };
		const configSchema = z.string().transform((value) => new Date(value));
		const plugin = definePlugin({
			api: new Hono<PluginEnv<State, Date>>(),
			configSchema,
			connection: () => ({ env: {}, values: {} }),
			description: "Mutable output fixture",
			id: "mutable-output",
			lifecycle: {
				create: () => undefined,
				start: (): State => ({ ready: true }),
			},
			operations: {},
			stateVersion: 1,
		});

		expect(() =>
			resolveConfig(
				{
					services: {
						mutable: plugin({ config: "2026-01-01T00:00:00.000Z" }),
					},
				},
				configPath,
			),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: [
						expect.objectContaining({
							code: "parsed_data_not_immutable",
							path: "$.services.mutable.config",
							received: "Date",
						}),
					],
				}),
			}),
		);
	});

	it.each([
		["record", z.record(z.string(), z.string())],
		[
			"intersection",
			z.intersection(z.object({ left: z.string() }), z.object({ right: z.string() })),
		],
		["union", z.union([z.object({ left: z.string() }), z.object({ right: z.string() })])],
		[
			"forged schema",
			{
				safeParse: (value: unknown) => ({ data: value, success: true }),
				toJSONSchema: () => ({ properties: {}, type: "object" }),
			},
		],
	])("rejects a non-ZodObject %s operation input at the runtime boundary", (_name, input) => {
		expect(() =>
			resolveConfig({ services: { untyped: untypedConfiguredService({ input }) } }, configPath),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: "operation_input_not_zod_object",
							path: "$.services.untyped.$plugin.operations.operate.input",
						}),
					]),
				}),
			}),
		);
	});

	it("accepts an actual ZodObject at the runtime boundary", () => {
		const resolved = resolveConfig(
			{
				services: {
					untyped: untypedConfiguredService({ input: z.object({ name: z.string() }) }),
				},
			},
			configPath,
		);
		expect(resolved.services.untyped?.operations.operate?.input.type).toBe("object");
	});

	it("validates every present optional lifecycle hook and seed property", () => {
		const descriptor = untypedConfiguredService({
			lifecycle: { seed: undefined, stop: "not-a-function", update: null },
		});
		let error: ConfigError | undefined;
		try {
			resolveConfig({ services: { untyped: descriptor } }, configPath);
		} catch (cause) {
			if (cause instanceof ConfigError) error = cause;
		}

		expect(error?.details.issues?.map((issue) => issue.code)).toEqual([
			"invalid_lifecycle_hook",
			"invalid_lifecycle_hook",
			"invalid_lifecycle_hook",
			"seed_contract_mismatch",
		]);
	});

	it("produces stable fingerprints without exposing configuration values", () => {
		const plugin = fixturePlugin();
		const first = resolveConfig(
			{ services: { fixture: plugin({ config: { token: "local-first" } }) } },
			configPath,
		);
		const same = resolveConfig(
			{ services: { fixture: plugin({ config: { nested: {}, token: "local-first" } }) } },
			configPath,
		);
		const changed = resolveConfig(
			{ services: { fixture: plugin({ config: { token: "local-second" } }) } },
			configPath,
		);

		expect(first.fingerprint).toBe(same.fingerprint);
		expect(changed.fingerprint).not.toBe(first.fingerprint);
		expect(first.fingerprint).not.toContain("local-first");
	});

	it("returns exact schema paths without leaking secret values", () => {
		const plugin = fixturePlugin();
		let error: ConfigError | undefined;
		try {
			resolveConfig(
				{ services: { fixture: plugin({ config: { token: "production-secret" } }) } },
				configPath,
			);
		} catch (cause) {
			if (cause instanceof ConfigError) error = cause;
		}

		expect(error?.toJSON()).toMatchInlineSnapshot(`
			{
			  "code": "CONFIG_INVALID",
			  "details": {
			    "configPath": "/workspace/project/localhost.config.ts",
			    "issues": [
			      {
			        "code": "invalid_format",
			        "expected": "starts_with",
			        "message": "Invalid string: must start with "local-"",
			        "path": "$.services.fixture.config.token",
			        "received": "string",
			        "serviceKey": "fixture",
			      },
			    ],
			  },
			  "message": "Invalid localhost2137 config at /workspace/project/localhost.config.ts (1 issue).",
			}
		`);
		expect(JSON.stringify(error)).not.toContain("production-secret");
	});

	it("diagnoses reserved identities and operation CLI collisions", () => {
		const collisionPlugin = fixturePlugin({ operationKeys: ["getURL", "getUrl"] });
		const validPlugin = fixturePlugin();
		expect(() =>
			resolveConfig(
				{
					services: {
						clock: validPlugin({ config: { token: "local-clock" } }),
						fixture: collisionPlugin({ config: { token: "local-fixture" } }),
					},
				},
				configPath,
			),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				code: "CONFIG_INVALID",
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({ code: "reserved_service_key", serviceKey: "clock" }),
						expect.objectContaining({
							code: "operation_cli_collision",
							message: 'Operations "getURL" and "getUrl" both map to CLI name "get-url".',
						}),
					]),
				}),
			}),
		);
	});

	it("reports both owners for exported environment collisions", () => {
		const plugin = fixturePlugin();
		expect(() =>
			resolveConfig(
				{
					services: {
						first: plugin({ config: { token: "local-first" } }),
						second: plugin({ config: { token: "local-second" } }),
					},
				},
				configPath,
			),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: "env_collision",
							message:
								'Services "first" and "second" both export "FIXTURE_TOKEN"; set exportEnv: false on one mount and wire it manually.',
						}),
					]),
				}),
			}),
		);
	});

	it("allows an intentional environment collision when one mount disables export", () => {
		const plugin = fixturePlugin();
		const config = resolveConfig(
			{
				services: {
					first: plugin({ config: { token: "local-first" } }),
					second: plugin({ config: { token: "local-second" }, exportEnv: false }),
				},
			},
			configPath,
		);
		expect(config.services.second?.connection.values).toEqual({
			credentials: { token: "local-second" },
		});
	});

	it("validates plugin IDs, state versions, and environment names at runtime", () => {
		const plugin = fixturePlugin({
			connectionName: "invalid-name",
			id: "Invalid Plugin",
			stateVersion: 0,
		});
		const descriptor = plugin({ config: { token: "local-token" } });
		expect(() => resolveConfig({ services: { fixture: descriptor } }, configPath)).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({ code: "invalid_plugin_id" }),
						expect.objectContaining({ code: "invalid_state_version" }),
						expect.objectContaining({ code: "invalid_env_name" }),
					]),
				}),
			}),
		);
	});

	it("reports config and operation schema introspection failures precisely", () => {
		type State = { readonly ready: true };
		const dateConfig = z.date();
		const bind = defineOperation<"dates", State, Date>();
		const operation = bind({
			description: "Return a date",
			input: z.object({}),
			output: z.date(),
			run: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		const plugin = definePlugin({
			api: new Hono<PluginEnv<State, Date>>(),
			configSchema: dateConfig,
			connection: () => ({ env: {}, values: {} }),
			description: "Unrepresentable schema fixture",
			id: "dates",
			lifecycle: {
				create: () => undefined,
				start: (): State => ({ ready: true }),
			},
			operations: { operation },
			stateVersion: 1,
		});

		expect(() =>
			resolveConfig(
				{ services: { dates: plugin({ config: new Date("2026-01-01T00:00:00.000Z") }) } },
				configPath,
			),
		).toThrowError(
			expect.objectContaining<Partial<ConfigError>>({
				details: expect.objectContaining({
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: "schema_introspection_failed",
							path: "$.services.dates.$plugin.configSchema",
						}),
						expect.objectContaining({
							code: "schema_introspection_failed",
							path: "$.services.dates.$plugin.operations.operation.output",
						}),
					]),
				}),
			}),
		);
	});

	it("redacts sensitive fields and handles cycles in diagnostic data", () => {
		const value: { authorization: string; nested?: unknown; visible: string } = {
			authorization: "Bearer private",
			visible: "safe",
		};
		value.nested = value;
		expect(redact(value)).toEqual({
			authorization: "[REDACTED]",
			nested: "[CIRCULAR]",
			visible: "safe",
		});
	});
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
