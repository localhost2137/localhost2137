import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "../../src/authoring/config.js";
import {
	type ConnectionContext,
	type ConnectionMetadata,
	definePlugin,
} from "../../src/authoring/plugin.js";
import { resolveConfig } from "../../src/config/config-resolution.js";
import {
	ConnectionResolutionError,
	resolveInstanceConnections,
} from "../../src/config/instance-connections.js";

describe("instance connection resolution", () => {
	it("owns instance-specific values and deterministically merges exported env", () => {
		const retained = { nested: { value: "original" } };
		const config = fixtureConfig({
			alpha: connectionPlugin("alpha", ({ baseUrl, instanceId, serviceKey }) => ({
				env: { Z_LAST: serviceKey, A_FIRST: instanceId },
				values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}`, retained },
			}))({ config: {} }),
			beta: connectionPlugin("beta", () => ({
				env: { BETA_TOKEN: "local-token" },
				values: { enabled: true },
			}))({ config: {} }),
		});

		const result = resolveInstanceConnections(config, {
			baseUrl: "http://127.0.0.1:32137",
			instanceId: "pr-1337",
		});
		retained.nested.value = "mutated";

		expect(result.env).toEqual({ A_FIRST: "pr-1337", BETA_TOKEN: "local-token", Z_LAST: "alpha" });
		expect(result.services.alpha?.values).toEqual({
			apiUrl: "http://127.0.0.1:32137/pr-1337/alpha",
			retained: { nested: { value: "original" } },
		});
		expect(Object.isFrozen(result.services.alpha?.values)).toBe(true);
		expect(Object.getPrototypeOf(result.env)).toBeNull();
	});

	it("keeps connection values while honoring exportEnv false", () => {
		const plugin = connectionPlugin("fixture", () => ({
			env: { FIXTURE_TOKEN: "token" },
			values: { token: "token" },
		}));
		const config = fixtureConfig({ fixture: plugin({ config: {}, exportEnv: false }) });

		const result = resolveInstanceConnections(config, {
			baseUrl: "http://127.0.0.1:2137",
			instanceId: "dev",
		});

		expect(result.env).toEqual({});
		expect(result.services.fixture?.values).toEqual({ token: "token" });
	});

	it("names both owners for actual-instance env collisions", () => {
		const plugin = (id: "alpha" | "beta") =>
			connectionPlugin(id, ({ instanceId }) => ({
				env: { [instanceId === "dev" ? `${id.toUpperCase()}_URL` : "SHARED_URL"]: id },
				values: {},
			}));
		const config = fixtureConfig({
			alpha: plugin("alpha")({ config: {} }),
			beta: plugin("beta")({ config: {} }),
		});

		expect(() =>
			resolveInstanceConnections(config, {
				baseUrl: "http://127.0.0.1:2137",
				instanceId: "other",
			}),
		).toThrow(
			expect.objectContaining({
				code: "CONNECTION_ENV_COLLISION",
				environmentName: "SHARED_URL",
				firstOwner: "alpha",
				serviceKey: "beta",
			}),
		);
	});

	it.each([
		["extra result keys", () => ({ env: {}, extra: true, values: {} })],
		["invalid env names", () => ({ env: { lower: "value" }, values: {} })],
		["non-string env", () => ({ env: { INVALID: 1 }, values: {} })],
		["NUL env values", () => ({ env: { INVALID: "value\0tail" }, values: {} })],
		["non-JSON values", () => ({ env: {}, values: { invalid: new Date() } })],
		["non-object values", () => ({ env: {}, values: [] })],
	])("rejects %s", (_name, connection) => {
		const plugin = connectionPlugin("fixture", (context) =>
			context.instanceId === "dev" ? { env: {}, values: {} } : connection(),
		);
		const config = fixtureConfig({ fixture: plugin({ config: {} }) });

		expect(() =>
			resolveInstanceConnections(config, {
				baseUrl: "http://127.0.0.1:2137",
				instanceId: "other",
			}),
		).toThrow(ConnectionResolutionError);
	});

	it("does not invoke accessor-backed result fields", () => {
		let invoked = false;
		const plugin = connectionPlugin("fixture", ({ instanceId }) => {
			if (instanceId === "dev") return { env: {}, values: {} };
			const result = { env: {}, values: {} };
			Object.defineProperty(result, "values", {
				enumerable: true,
				get() {
					invoked = true;
					return {};
				},
			});
			return result;
		});
		const config = fixtureConfig({ fixture: plugin({ config: {} }) });

		expect(() =>
			resolveInstanceConnections(config, {
				baseUrl: "http://127.0.0.1:2137",
				instanceId: "other",
			}),
		).toThrow(ConnectionResolutionError);
		expect(invoked).toBe(false);
	});
});

function fixtureConfig(services: Readonly<Record<string, unknown>>) {
	return resolveConfig(
		defineConfig({ services: services as never }),
		join(process.cwd(), "fixtures", "localhost.config.ts"),
	);
}

function connectionPlugin<const Id extends string>(
	id: Id,
	connection: (context: ConnectionContext<Record<string, never>>) => unknown,
) {
	return definePlugin({
		api: new Hono(),
		configSchema: z.object({}),
		connection: connection as (
			context: ConnectionContext<Record<string, never>>,
		) => ConnectionMetadata,
		description: `${id} fixture`,
		id,
		lifecycle: { create: () => undefined, start: () => ({}) },
		operations: {},
		stateVersion: 1,
	});
}
