import {
	type ContractOperationInput,
	type ContractOperationKey,
	type ContractOperationOutput,
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
	stateVersion: 2,
});
const configured = () => plugin({ config: { greeting: "Hello" } });
const config = () => defineConfig({ services: { typed: configured() } });
type Services = ReturnType<typeof config>["services"];

const fixture = {
	authoring: { exportName: "config", module: new URL("./typed.config.js", import.meta.url) },
	connection: { environmentName: "TYPED_URL", valueKey: "apiUrl" as const },
	durability: {
		configModule: new URL("./typed.config.js", import.meta.url),
		expectedInitial: { greeting: "Hello, Ada" },
		expectedPersisted: { greeting: "Hello, Ada" },
		expectedWrite: { greeting: "Hello, Grace" },
		read: { input: { name: "Ada" }, operation: "greet" as const },
		versions: { current: 2, future: 3, old: 1 },
		write: { input: { name: "Grace" }, operation: "greet" as const },
	},
	faults: {
		invalidOutput: { input: { name: "Ada" }, operation: "greet" as const },
		storageEscape: { input: { name: "Ada" }, operation: "greet" as const },
	},
	harness: {
		createConfig: ({ instrumentation, variant }) => {
			instrumentation.record("create");
			void variant;
			return config();
		},
		createInvalidConfig: (_kind: "config" | "seed") => ({}),
		createService: configured,
		pluginId: "typed",
		stateVersion: 2,
	},
	hono: {
		expectedBody: { greeting: "Hello, Ada" },
		expectedStatus: 200,
		instanceIdProperty: "instanceId",
		path: "/greeting" as const,
	},
	invalid: { configPath: ["greeting"], seedPath: ["name"] },
	isolation: {
		expectedFresh: { greeting: "Hello, Ada" },
		expectedMutated: { greeting: "Hello, Grace" },
		mutate: { input: { name: "Grace" }, operation: "greet" as const },
		read: { input: { name: "Ada" }, operation: "greet" as const },
	},
	operations: [
		{
			cli: "flags" as const,
			expected: { greeting: "Hello, Ada" },
			input: { name: "Ada" },
			key: "greet" as const,
		},
	],
	reset: {
		expectedEmpty: { greeting: "Hello, Ada" },
		expectedSeeded: { greeting: "Hello, Ada" },
		mutate: { input: { name: "Grace" }, operation: "greet" as const },
		read: { input: { name: "Ada" }, operation: "greet" as const },
	},
	serviceKey: "typed" as const,
	trackedFetch: {
		expected: { greeting: "Hello, dynamic" },
		input: (_testkitOwnedUrl: string) => ({ name: "dynamic" }),
		operation: "greet" as const,
	},
} satisfies PluginContractFixture<Services>;

const cases = createPluginContractCases(fixture);
const caseName: string | undefined = cases[0]?.name;
const operationKey: "greet" | undefined = fixture.operations[0]?.key;
const validInput: ContractOperationInput<Services, "typed", "greet"> = { name: "Ada" };
const validOutput: ContractOperationOutput<Services, "typed", "greet"> = { greeting: "Hello" };
// @ts-expect-error selected-service operation keys reject misspellings
const missingOperation: ContractOperationKey<Services, "typed"> = "missing";
// @ts-expect-error declarative operation input preserves the production operation input type
const invalidInput: ContractOperationInput<Services, "typed", "greet"> = { name: 2137 };
const run: Promise<void> = runPluginContract(fixture);
void caseName;
void invalidInput;
void missingOperation;
void operationKey;
void run;
void validInput;
void validOutput;
