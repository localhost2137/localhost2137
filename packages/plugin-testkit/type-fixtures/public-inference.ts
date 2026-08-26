import {
	type ContractOperationKey,
	createPluginContractCases,
	type PluginContractFixture,
	runPluginContract,
} from "@localhost2137/plugin-testkit";
import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
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
const observation = () => ({ actual: true, expected: true });
const invalid = { create: () => ({}), expectedPath: "$.services.typed" };

const fixture = {
	authoring: { sideEffects: observation },
	durability: {
		futureVersion: observation,
		restartPersistence: observation,
		stateUpgrade: observation,
	},
	invalid: { config: invalid, environmentCollision: invalid, seed: invalid },
	lifecycle: {
		createFailureRecovery: observation,
		ordering: observation,
		updateFailureRecovery: observation,
	},
	probes: {
		connection: {
			environmentName: "TYPED_URL",
			readUrl: (instance) => instance.typed.connection.apiUrl,
		},
		honoContext: async (instance) => {
			// @ts-expect-error fixture callbacks preserve configured operation input types
			void instance.typed.greet({ name: 2137 });
			return {
				actual: await instance.typed.greet({ name: "Ada" }),
				expected: { greeting: "Hello, Ada" },
			};
		},
		isolation: {
			expectedFresh: "Hello, Ada",
			expectedMutated: "Hello, Grace",
			mutate: async (instance) => {
				await instance.typed.greet({ name: "Grace" });
			},
			read: async (instance) => (await instance.typed.greet({ name: "Ada" })).greeting,
		},
		outputValidation: observation,
		reset: {
			expectedEmpty: "Hello, Ada",
			expectedSeeded: "Hello, Ada",
			mutate: async (instance) => {
				await instance.typed.greet({ name: "Grace" });
			},
			read: async (instance) => (await instance.typed.greet({ name: "Ada" })).greeting,
		},
		storageEscape: observation,
		trackedFetchAndIdle: async (instance) => ({
			actual: await instance.typed.greet({ name: "Ada" }),
			expected: { greeting: "Hello, Ada" },
		}),
	},
	world: {
		createConfig: () => config,
		operations: [
			{
				cli: "flags" as const,
				invoke: async (instance) => ({
					actual: await instance.typed.greet({ name: "Ada" }),
					expected: { greeting: "Hello, Ada" },
				}),
				key: "greet",
			},
		],
		serviceKey: "typed" as const,
	},
} satisfies PluginContractFixture<typeof config.services>;

const cases = createPluginContractCases(fixture);
const caseName: string | undefined = cases[0]?.name;
const operationKey: "greet" | undefined = fixture.world.operations[0]?.key;
// @ts-expect-error selected-service operation keys reject misspellings
const missingOperation: ContractOperationKey<typeof config.services, "typed"> = "missing";
const run: Promise<void> = runPluginContract(fixture);
void caseName;
void missingOperation;
void operationKey;
void run;
