import { Hono } from "hono";
import {
	defineConfig,
	defineOperation,
	definePlugin,
	LocalhostError,
	type PluginEnv,
} from "localhost2137";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const configSchema = z.object({ greeting: z.string() });
type Config = z.output<typeof configSchema>;
type State = { readonly ready: true };

function pluginDefinition(operations: Readonly<Record<string, ReturnType<OperationBinder>>>) {
	return {
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema,
		connection: () => ({ env: {}, values: {} }),
		description: "Authoring fixture",
		id: "fixture" as const,
		lifecycle: {
			create: () => undefined,
			start: (): State => ({ ready: true }),
		},
		operations,
		stateVersion: 1,
	};
}

type OperationBinder = ReturnType<typeof defineOperation<"fixture", State, Config>>;

function greetOperation(binder: OperationBinder) {
	return binder({
		description: "Return a greeting",
		input: z.object({ name: z.string() }),
		output: z.object({ greeting: z.string() }),
		run: (context, input) => ({ greeting: `${context.config.greeting}, ${input.name}` }),
	});
}

describe("authoring descriptors", () => {
	it("keeps the public root limited to authoring APIs", async () => {
		const publicRoot = await import("localhost2137");
		expect(Object.keys(publicRoot).sort()).toEqual([
			"LocalhostError",
			"defineConfig",
			"defineOperation",
			"definePlugin",
		]);
		expect("loadResolvedConfig" in publicRoot).toBe(false);
	});

	it("keeps expected plugin error causes internal", () => {
		const internal = new Error("private detail");
		const error = new LocalhostError("USER_EXISTS", "That user already exists.", {
			cause: internal,
			details: { field: "name" },
			status: 409,
		});

		expect(error).toMatchObject({
			code: "USER_EXISTS",
			details: { field: "name" },
			message: "That user already exists.",
			status: 409,
		});
		expect(error.cause).toBe(internal);
		expect(Object.keys(error)).not.toContain("cause");
	});

	it("creates immutable descriptors without freezing Hono or Zod internals", () => {
		const operation = greetOperation(defineOperation<"fixture", State, Config>());
		const api = new Hono<PluginEnv<State, Config>>();
		const plugin = definePlugin({ ...pluginDefinition({ greet: operation }), api });
		const service = plugin({ config: { greeting: "Hello" } });

		expect(Object.isFrozen(operation)).toBe(true);
		expect(Object.isFrozen(service)).toBe(true);
		expect(Object.isFrozen(api)).toBe(false);
		expect(Object.isFrozen(configSchema)).toBe(false);
	});

	it("rejects operations from multiple runtime binders", () => {
		const first = greetOperation(defineOperation<"fixture", State, Config>());
		const second = greetOperation(defineOperation<"fixture", State, Config>());

		expect(() => definePlugin(pluginDefinition({ first, second }))).toThrow(
			'Plugin "fixture" mixes operations from different binders.',
		);
	});

	it("preserves config identity until the resolver parses it", () => {
		const value = defineConfig({ services: {} });
		expect(defineConfig(value)).toBe(value);
	});
});
