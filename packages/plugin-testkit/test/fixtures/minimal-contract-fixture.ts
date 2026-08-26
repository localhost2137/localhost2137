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
		arrange: Object.freeze([
			Object.freeze({ input: Object.freeze({ by: 1 }), operation: "increment" as const }),
		]),
		configModule: new URL("./durability-daemon.config.ts", import.meta.url),
		expectedInitial: Object.freeze({ value: 1 }),
		expectedPersisted: Object.freeze({ value: 42 }),
		expectedWrite: Object.freeze({ label: "isolated", value: 42 }),
		read: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
		versions: Object.freeze({ current: 2, future: 3, old: 1 }),
		write: Object.freeze({ input: Object.freeze({ by: 41 }), operation: "increment" as const }),
	}),
	faults: Object.freeze({
		invalidOutput: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
		storageEscape: Object.freeze({ input: Object.freeze({}), operation: "read" as const }),
	}),
	harness: Object.freeze({
		createConfig: ({ instrumentation, resources, variant }) => {
			let shouldFailCreate = variant === "create-fails-once";
			return createFixtureConfig(resources.deliveryUrl, {
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
		createInvalidConfig: (kind, resources) =>
			createInvalidFixtureConfig(kind, resources.deliveryUrl),
		createService: (resources) => createFixtureService(resources.deliveryUrl),
		pluginId: "fixture",
		stateVersion: 2,
	}),
	hono: Object.freeze({
		arrange: Object.freeze({
			first: Object.freeze({
				expected: Object.freeze({ label: "isolated", value: 5 }),
				invoke: Object.freeze({
					input: Object.freeze({ by: 5 }),
					operation: "increment" as const,
				}),
			}),
			second: Object.freeze({
				expected: Object.freeze({ label: "isolated", value: 9 }),
				invoke: Object.freeze({
					input: Object.freeze({ by: 9 }),
					operation: "increment" as const,
				}),
			}),
		}),
		expected: Object.freeze({
			first: Object.freeze({
				data: Object.freeze({ label: "isolated", value: 5 }),
				status: 200,
			}),
			second: Object.freeze({
				data: Object.freeze({ label: "isolated", value: 9 }),
				status: 200,
			}),
		}),
		normalize: (body: unknown) => {
			if (typeof body !== "object" || body === null) return body;
			return Object.freeze({
				label: Reflect.get(body, "label"),
				value: Reflect.get(body, "value"),
			});
		},
		request: (connection) =>
			Object.freeze({
				responseBody: "json" as const,
				url: `${connection.apiUrl}/value`,
			}),
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
			input: Object.freeze({ message: "contract operation" }),
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
		arrange: Object.freeze([]),
		expected: Object.freeze({ queued: true as const }),
		invoke: Object.freeze({
			input: Object.freeze({ message: "tracked delivery" }),
			operation: "deliver" as const,
		}),
	}),
} satisfies PluginContractFixture<Services>);
