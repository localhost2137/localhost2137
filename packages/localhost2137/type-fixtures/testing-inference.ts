import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { z } from "zod";

type Config = Readonly<{ greeting: string }>;
type State = Readonly<{ ready: true }>;
const operation = defineOperation<"typed", State, Config>();
const greet = operation({
	description: "Greet a person",
	input: z.object({ name: z.string() }),
	output: z.object({ greeting: z.string() }),
	run: (context, input) => ({ greeting: `${context.config.greeting}, ${input.name}` }),
});
const plugin = definePlugin({
	api: new Hono<PluginEnv<State, Config>>(),
	configSchema: z.object({ greeting: z.string() }),
	connection: ({ baseUrl, instanceId, serviceKey }) => ({
		env: { TYPED_URL: `${baseUrl}/${instanceId}/${serviceKey}` },
		values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}` },
	}),
	description: "Typed fixture",
	id: "typed",
	lifecycle: {
		create: () => undefined,
		start: (): State => ({ ready: true }),
	},
	operations: { greet },
	stateVersion: 1,
});
const config = defineConfig({
	services: { typed: plugin({ config: { greeting: "Hello" } }) },
});

const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
const instance = await runtime.createInstance();
const result: { greeting: string } = await instance.typed.greet({ name: "Ada" });
const apiUrl: string = instance.typed.connection.apiUrl;
void result;
void apiUrl;

// @ts-expect-error configured service operation inputs remain inferred
await instance.typed.greet({ name: 2137 });
// @ts-expect-error unconfigured services are absent
instance.slack;
// @ts-expect-error port zero is mandatory for test isolation
await createTestRuntime({ config, port: 2137, storage: "temporary" });
// @ts-expect-error temporary is the only owned test storage contract
await createTestRuntime({ config, port: 0, storage: "persistent" });

await instance.destroy();
await runtime.close();
