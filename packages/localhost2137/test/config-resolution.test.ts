import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, definePlugin, type PluginEnv } from "../src/authoring/index.js";
import { ConfigError } from "../src/config/config-error.js";
import { resolveConfig } from "../src/config/config-resolution.js";
import { redact } from "../src/config/redaction.js";

interface FixtureOptions {
	readonly connectionName?: string;
	readonly id?: string;
	readonly nestedInput?: boolean;
	readonly operationKeys?: readonly string[];
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
		connection: ({ config }) => ({
			env: { [options.connectionName ?? "FIXTURE_TOKEN"]: config.token },
			values: { credentials: { token: config.token } },
		}),
		description: "Resolver fixture",
		id,
		lifecycle: {
			create: () => undefined,
			start: (): State => ({ ready: true }),
		},
		operations,
		stateVersion: 1,
	});
}

describe("config resolution", () => {
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
