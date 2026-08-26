import { defineConfig } from "localhost2137";
import type {
	ContractHarnessConfigOptions,
	ContractHarnessResources,
	PluginContractFixture,
} from "@localhost2137/plugin-testkit";
import { createSlackPlugin } from "../../src/plugin.js";

const PINNED_TIME = "2026-01-02T03:04:05.000Z";

type SlackContractServices = ReturnType<typeof createSlackContractConfig>["services"];

export const slackContractFixture = Object.freeze({
	authoring: Object.freeze({
		exportName: "slackAuthoringConfig",
		module: new URL("./slack-authoring.config.mjs", import.meta.url),
	}),
	connection: Object.freeze({
		environmentName: "SLACK_API_URL",
		valueKey: "apiUrl" as const,
	}),
	durability: Object.freeze({
		arrange: Object.freeze([
			Object.freeze({ input: Object.freeze({ name: "Ada" }), operation: "createUser" as const }),
			Object.freeze({
				input: Object.freeze({ name: "general" }),
				operation: "createChannel" as const,
			}),
			Object.freeze({
				input: Object.freeze({ channel: "general", user: "U000001" }),
				operation: "addUserToChannel" as const,
			}),
		]),
		configModule: new URL("./slack-durability.config.ts", import.meta.url),
		expectedInitial: Object.freeze([]),
		expectedPersisted: Object.freeze([message(null)]),
		expectedWrite: message("Ev000001"),
		read: Object.freeze({
			input: Object.freeze({ channel: "general" }),
			operation: "listMessages" as const,
		}),
		versions: Object.freeze({ current: 2, future: 3, old: 1 }),
		write: Object.freeze({
			input: Object.freeze({ channel: "general", from: "U000001", text: "durable" }),
			operation: "sendMessage" as const,
		}),
	}),
	faults: Object.freeze({
		invalidOutput: Object.freeze({
			input: Object.freeze({ name: "invalid-output" }),
			operation: "createUser" as const,
		}),
		storageEscape: Object.freeze({
			input: Object.freeze({ name: "storage-escape" }),
			operation: "createUser" as const,
		}),
	}),
	harness: Object.freeze({
		createConfig: (options: ContractHarnessConfigOptions) =>
			createSlackContractConfig(options.resources.deliveryUrl, options),
		createInvalidConfig: (kind: "config" | "seed", resources: ContractHarnessResources) =>
			createInvalidSlackConfig(kind, resources.deliveryUrl),
		createService: (resources: ContractHarnessResources) =>
			createSlackService(resources.deliveryUrl),
		pluginId: "slack",
		stateVersion: 2,
	}),
	hono: Object.freeze({
		arrange: Object.freeze({
			first: Object.freeze({
				expected: Object.freeze({ admin: false, id: "U000001", name: "Ada" }),
				invoke: Object.freeze({
					input: Object.freeze({ name: "Ada" }),
					operation: "createUser" as const,
				}),
			}),
			second: Object.freeze({
				expected: Object.freeze({ admin: false, id: "U000001", name: "Grace" }),
				invoke: Object.freeze({
					input: Object.freeze({ name: "Grace" }),
					operation: "createUser" as const,
				}),
			}),
		}),
		expected: Object.freeze({
			first: Object.freeze({
				data: Object.freeze([{ id: "U000001", name: "Ada" }]),
				status: 200,
			}),
			second: Object.freeze({
				data: Object.freeze([{ id: "U000001", name: "Grace" }]),
				status: 200,
			}),
		}),
		normalize: (body: unknown) => normalizeMembers(body),
		request: (connection: Readonly<{ apiUrl: string; botToken: string }>) =>
			Object.freeze({
				headers: Object.freeze({ authorization: `Bearer ${connection.botToken}` }),
				responseBody: "json" as const,
				url: `${connection.apiUrl}users.list`,
			}),
	}),
	invalid: Object.freeze({
		configPath: Object.freeze(["workspaceName"]),
		seedPath: Object.freeze(["users", 0, "name"]),
	}),
	isolation: Object.freeze({
		expectedFresh: Object.freeze({ admin: false, id: "U000001", name: "Ada" }),
		expectedMutated: Object.freeze({ admin: false, id: "U000002", name: "Ada" }),
		mutate: Object.freeze({
			input: Object.freeze({ name: "Grace" }),
			operation: "createUser" as const,
		}),
		read: Object.freeze({
			input: Object.freeze({ name: "Ada" }),
			operation: "createUser" as const,
		}),
	}),
	operations: Object.freeze([
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ admin: false, id: "U000001", name: "Ada" }),
			input: Object.freeze({ name: "Ada" }),
			key: "createUser" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ id: "C000001", name: "general" }),
			input: Object.freeze({ name: "general" }),
			key: "createChannel" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ added: true, channel: "C000001", user: "U000001" }),
			input: Object.freeze({ channel: "general", user: "U000001" }),
			key: "addUserToChannel" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: message("Ev000001", "contract operation"),
			input: Object.freeze({
				channel: "general",
				from: "U000001",
				text: "contract operation",
			}),
			key: "sendMessage" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: [message(null, "contract operation")],
			input: Object.freeze({ channel: "general" }),
			key: "listMessages" as const,
		}),
	]),
	reset: Object.freeze({
		expectedEmpty: Object.freeze({ admin: false, id: "U000001", name: "Ada" }),
		expectedSeeded: Object.freeze({ admin: false, id: "U000002", name: "Ada" }),
		mutate: Object.freeze({
			input: Object.freeze({ name: "Grace" }),
			operation: "createUser" as const,
		}),
		read: Object.freeze({
			input: Object.freeze({ name: "Ada" }),
			operation: "createUser" as const,
		}),
	}),
	serviceKey: "slack" as const,
	trackedFetch: Object.freeze({
		arrange: Object.freeze([
			Object.freeze({ input: Object.freeze({ name: "Ada" }), operation: "createUser" as const }),
			Object.freeze({
				input: Object.freeze({ name: "general" }),
				operation: "createChannel" as const,
			}),
			Object.freeze({
				input: Object.freeze({ channel: "general", user: "U000001" }),
				operation: "addUserToChannel" as const,
			}),
		]),
		expected: message("Ev000001", "tracked delivery"),
		invoke: Object.freeze({
			input: Object.freeze({
				channel: "general",
				from: "U000001",
				text: "tracked delivery",
			}),
			operation: "sendMessage" as const,
		}),
	}),
}) satisfies PluginContractFixture<SlackContractServices>;

function createSlackContractConfig(
	deliveryUrl: string,
	options?: ContractHarnessConfigOptions,
) {
	let shouldFailCreate = options?.variant === "create-fails-once";
	return defineConfig({
		clock: { mode: "pinned", startAt: PINNED_TIME },
		services: {
			slack: createSlackPlugin({
				...(options?.variant === "create-fails-once"
					? {
							beforeCreate: () => {
								if (!shouldFailCreate) return;
								shouldFailCreate = false;
								throw new Error("injected Slack create failure");
							},
						}
					: {}),
				...(options?.variant === "storage-escape"
					? {
							beforeOperation: (operation, context) => {
								if (operation === "createUser") context.storage.path("../escape");
							},
						}
					: {}),
				...(options ? { recordLifecycle: options.instrumentation.record } : {}),
				...(options?.variant === "invalid-output"
					? {
							transformOperationResult: <Value>(operation: string, value: Value): Value =>
								operation === "createUser" ? ({ invalid: true } as Value) : value,
						}
					: {}),
			})({
				config: config(deliveryUrl),
				seed: { channels: [], users: [{ name: "Grace" }] },
			}),
		},
	});
}

function createSlackService(deliveryUrl: string) {
	return createSlackPlugin()({
		config: config(deliveryUrl),
		seed: { channels: [], users: [{ name: "Grace" }] },
	});
}

function createInvalidSlackConfig(kind: "config" | "seed", deliveryUrl: string): unknown {
	const envelope =
		kind === "config"
			? { config: { ...config(deliveryUrl), workspaceName: 2137 }, seed: { users: [] } }
			: {
					config: config(deliveryUrl),
					seed: { users: [{ name: 2137 }] },
				};
	return {
		services: {
			slack: Reflect.apply(createSlackPlugin(), undefined, [envelope]),
		},
	};
}

function config(eventsUrl: string) {
	return {
		botToken: "xoxb-local-contract",
		eventsUrl,
		signingSecret: "local-contract-secret",
		workspaceName: "Contract Workspace",
	} as const;
}

function message(eventId: string | null, text = "durable") {
	return Object.freeze({
		channel: "C000001",
		eventId,
		id: "M000001",
		text,
		threadTs: null,
		ts: "1767323045.000000",
		userId: "U000001",
	});
}

function normalizeMembers(body: unknown) {
	if (typeof body !== "object" || body === null) return body;
	const members = Reflect.get(body, "members");
	if (!Array.isArray(members)) return members;
	return members
		.filter(
			(member) => typeof member === "object" && member !== null && !Reflect.get(member, "is_bot"),
		)
		.map((member) => ({ id: Reflect.get(member, "id"), name: Reflect.get(member, "name") }));
}
