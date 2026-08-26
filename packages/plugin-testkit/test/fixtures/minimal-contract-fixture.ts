import type { PluginContractFixture } from "../../src/index.js";
import {
	createFixtureConfig,
	createFixtureService,
	createInvalidFixtureConfig,
	type fixtureConfig,
} from "./fixture-plugin.js";

type Services = typeof fixtureConfig.services;

export const minimalContractFixture = Object.freeze({
	authoring: Object.freeze({
		exportName: "fixtureConfig",
		module: new URL("./fixture-plugin.ts", import.meta.url),
	}),
	connection: Object.freeze({
		environmentName: "FIXTURE_API_URL",
		valueKey: "apiUrl" as const,
	}),
	durability: Object.freeze({
		configModule: new URL("./durability-daemon.config.ts", import.meta.url),
		expectedInitial: Object.freeze({ value: 0 }),
		expectedPersisted: Object.freeze({ value: 41 }),
		expectedWrite: Object.freeze({ label: "isolated", value: 41 }),
		read: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
		versions: Object.freeze({ current: 2, future: 3, old: 1 }),
		write: Object.freeze({ input: Object.freeze({ by: 41 }), operation: "increment" as const }),
	}),
	faults: Object.freeze({
		invalidOutput: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
		storageEscape: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
	}),
	harness: Object.freeze({
		createConfig: ({ instrumentation, variant }) => {
			let shouldFailCreate = variant === "create-fails-once";
			return createFixtureConfig({
				failCreateOnce:
					variant === "create-fails-once"
						? () => {
								if (!shouldFailCreate) return;
								shouldFailCreate = false;
								throw new Error("injected create failure");
							}
						: undefined,
				invalidOutput: variant === "invalid-output",
				record: instrumentation.record,
				storageEscape: variant === "storage-escape",
			});
		},
		createInvalidConfig: createInvalidFixtureConfig,
		createService: createFixtureService,
		pluginId: "fixture",
		stateVersion: 2,
	}),
	hono: Object.freeze({
		expectedBody: Object.freeze({ label: "isolated", value: 0 }),
		expectedStatus: 200,
		instanceIdProperty: "instanceId",
		path: "/value" as const,
	}),
	invalid: Object.freeze({
		configPath: Object.freeze(["label"]),
		seedPath: Object.freeze(["value"]),
	}),
	isolation: Object.freeze({
		expectedFresh: Object.freeze({ value: 0 }),
		expectedMutated: Object.freeze({ value: 5 }),
		mutate: Object.freeze({ input: Object.freeze({ by: 5 }), operation: "increment" as const }),
		read: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
	}),
	operations: Object.freeze([
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ queued: true as const }),
			input: Object.freeze({ url: "data:text/plain,ok" }),
			key: "deliver" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ label: "isolated", value: 2 }),
			input: Object.freeze({ by: 2 }),
			key: "increment" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ value: 2 }),
			input: Object.freeze({}),
			key: "read" as const,
		}),
	]),
	reset: Object.freeze({
		expectedEmpty: Object.freeze({ value: 0 }),
		expectedSeeded: Object.freeze({ value: 7 }),
		mutate: Object.freeze({ input: Object.freeze({ by: 3 }), operation: "increment" as const }),
		read: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
	}),
	serviceKey: "fixture" as const,
	trackedFetch: Object.freeze({
		expected: Object.freeze({ queued: true as const }),
		input: (testkitOwnedUrl: string) => Object.freeze({ url: testkitOwnedUrl }),
		operation: "deliver" as const,
	}),
} satisfies PluginContractFixture<Services>);
