import type {
	ContractHarnessConfigOptions,
	ContractHarnessResources,
	PluginContractFixture,
} from "@localhost2137/plugin-testkit";
import { defineConfig } from "localhost2137";
import { createStripePlugin } from "../../src/plugin.js";

const PINNED_TIME = "2026-01-02T03:04:05.000Z";

type StripeContractServices = ReturnType<typeof createStripeContractConfig>["services"];

const catalogArrange = Object.freeze([
	Object.freeze({
		input: Object.freeze({ name: "Ada" }),
		operation: "createCustomer" as const,
	}),
	Object.freeze({ input: Object.freeze({ name: "Pro" }), operation: "createProduct" as const }),
	Object.freeze({
		input: Object.freeze({ productId: "prod_000001", unitAmount: 2_500 }),
		operation: "createPrice" as const,
	}),
]);
const subscriptionArrange = Object.freeze([
	...catalogArrange,
	Object.freeze({
		input: Object.freeze({ customerId: "cus_000001", priceId: "price_000001" }),
		operation: "createSubscription" as const,
	}),
]);

export const stripeContractFixture = Object.freeze({
	authoring: Object.freeze({
		exportName: "stripeAuthoringConfig",
		module: new URL("./stripe-authoring.config.mjs", import.meta.url),
	}),
	connection: Object.freeze({
		environmentName: "STRIPE_API_URL",
		valueKey: "apiUrl" as const,
	}),
	durability: Object.freeze({
		arrange: catalogArrange,
		configModule: new URL("./stripe-durability.config.ts", import.meta.url),
		expectedInitial: Object.freeze([]),
		expectedPersisted: Object.freeze([invoice()]),
		expectedWrite: subscription(),
		read: Object.freeze({ input: Object.freeze({}), operation: "listInvoices" as const }),
		startupRecovery: Object.freeze({
			arrange: subscriptionArrange,
			deliveries: Object.freeze({ afterInterruption: 1, afterRecovery: 2 }),
			observations: Object.freeze([
				Object.freeze({
					expected: Object.freeze([invoice()]),
					read: Object.freeze({ input: Object.freeze({}), operation: "listInvoices" as const }),
				}),
				Object.freeze({
					expected: Object.freeze([event()]),
					read: Object.freeze({ input: Object.freeze({}), operation: "listEvents" as const }),
				}),
			]),
		}),
		timeAdvance: Object.freeze({
			arrange: subscriptionArrange,
			deliveries: Object.freeze({
				afterArrange: 1,
				afterCommittedAdvance: 1,
				afterRecovery: 2,
			}),
			duration: "30d",
			observations: Object.freeze([
				Object.freeze({
					expected: Object.freeze([invoice(), renewalInvoice()]),
					read: Object.freeze({ input: Object.freeze({}), operation: "listInvoices" as const }),
				}),
				Object.freeze({
					expected: Object.freeze([event(), renewalEvent()]),
					read: Object.freeze({ input: Object.freeze({}), operation: "listEvents" as const }),
				}),
			]),
		}),
		versions: Object.freeze({ current: 3, future: 4, old: 2 }),
		write: Object.freeze({
			input: Object.freeze({ customerId: "cus_000001", priceId: "price_000001" }),
			operation: "createSubscription" as const,
		}),
	}),
	faults: Object.freeze({
		invalidOutput: Object.freeze({
			input: Object.freeze({ name: "invalid-output" }),
			operation: "createCustomer" as const,
		}),
		storageEscape: Object.freeze({
			input: Object.freeze({ name: "storage-escape" }),
			operation: "createCustomer" as const,
		}),
	}),
	harness: Object.freeze({
		createConfig: (options: ContractHarnessConfigOptions) =>
			createStripeContractConfig(options.resources.deliveryUrl, options),
		createInvalidConfig: (kind: "config" | "seed", resources: ContractHarnessResources) =>
			createInvalidStripeConfig(kind, resources.deliveryUrl),
		createService: (resources: ContractHarnessResources) =>
			createStripeService(resources.deliveryUrl),
		pluginId: "stripe",
		stateVersion: 3,
	}),
	hono: Object.freeze({
		arrange: Object.freeze({
			first: Object.freeze({
				expected: customer("Ada"),
				invoke: Object.freeze({
					input: Object.freeze({ name: "Ada" }),
					operation: "createCustomer" as const,
				}),
			}),
			second: Object.freeze({
				expected: customer("Grace"),
				invoke: Object.freeze({
					input: Object.freeze({ name: "Grace" }),
					operation: "createCustomer" as const,
				}),
			}),
		}),
		expected: Object.freeze({
			first: Object.freeze({
				data: Object.freeze([{ id: "cus_000001", name: "Ada" }]),
				status: 200,
			}),
			second: Object.freeze({
				data: Object.freeze([{ id: "cus_000001", name: "Grace" }]),
				status: 200,
			}),
		}),
		normalize: normalizeCustomers,
		request: (connection: Readonly<{ apiUrl: string; secretKey: string }>) =>
			Object.freeze({
				headers: Object.freeze({ authorization: `Bearer ${connection.secretKey}` }),
				responseBody: "json" as const,
				url: `${connection.apiUrl}/v1/customers`,
			}),
	}),
	invalid: Object.freeze({
		configPath: Object.freeze(["secretKey"]),
		seedPath: Object.freeze(["customers", 0, "name"]),
	}),
	isolation: Object.freeze({
		expectedFresh: customer("Ada"),
		expectedMutated: customer("Ada", "cus_000002"),
		mutate: Object.freeze({
			input: Object.freeze({ name: "Grace" }),
			operation: "createCustomer" as const,
		}),
		read: Object.freeze({
			input: Object.freeze({ name: "Ada" }),
			operation: "createCustomer" as const,
		}),
	}),
	operations: Object.freeze([
		Object.freeze({
			cli: "flags" as const,
			expected: customer("Ada"),
			input: Object.freeze({ name: "Ada" }),
			key: "createCustomer" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: product(),
			input: Object.freeze({ name: "Pro" }),
			key: "createProduct" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: price(),
			input: Object.freeze({ productId: "prod_000001", unitAmount: 2_500 }),
			key: "createPrice" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: subscription(),
			input: Object.freeze({ customerId: "cus_000001", priceId: "price_000001" }),
			key: "createSubscription" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: [invoice()],
			input: Object.freeze({}),
			key: "listInvoices" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: [event()],
			input: Object.freeze({}),
			key: "listEvents" as const,
		}),
		Object.freeze({
			cli: "flags" as const,
			expected: Object.freeze({ outcome: "failed", subscriptionId: "sub_000001" }),
			input: Object.freeze({ outcome: "failed", subscriptionId: "sub_000001" }),
			key: "setNextPaymentOutcome" as const,
		}),
	]),
	reset: Object.freeze({
		expectedEmpty: customer("Ada"),
		expectedSeeded: customer("Ada", "cus_000002"),
		mutate: Object.freeze({
			input: Object.freeze({ name: "Grace" }),
			operation: "createCustomer" as const,
		}),
		read: Object.freeze({
			input: Object.freeze({ name: "Ada" }),
			operation: "createCustomer" as const,
		}),
	}),
	serviceKey: "stripe" as const,
	trackedFetch: Object.freeze({
		arrange: Object.freeze([
			Object.freeze({
				input: Object.freeze({ name: "Ada" }),
				operation: "createCustomer" as const,
			}),
			Object.freeze({ input: Object.freeze({ name: "Pro" }), operation: "createProduct" as const }),
			Object.freeze({
				input: Object.freeze({ productId: "prod_000001", unitAmount: 2_500 }),
				operation: "createPrice" as const,
			}),
		]),
		expected: subscription(),
		invoke: Object.freeze({
			input: Object.freeze({ customerId: "cus_000001", priceId: "price_000001" }),
			operation: "createSubscription" as const,
		}),
	}),
}) satisfies PluginContractFixture<StripeContractServices>;

function createStripeContractConfig(webhookUrl: string, options?: ContractHarnessConfigOptions) {
	let shouldFailCreate = options?.variant === "create-fails-once";
	return defineConfig({
		clock: { mode: "pinned", startAt: PINNED_TIME },
		services: {
			stripe: createStripePlugin({
				...(options?.variant === "create-fails-once"
					? {
							beforeCreate: () => {
								if (!shouldFailCreate) return;
								shouldFailCreate = false;
								throw new Error("injected Stripe create failure");
							},
						}
					: {}),
				...(options?.variant === "storage-escape"
					? {
							beforeOperation: (operation, context) => {
								if (operation === "createCustomer") context.storage.path("../escape");
							},
						}
					: {}),
				...(options ? { recordLifecycle: options.instrumentation.record } : {}),
				...(options?.variant === "invalid-output"
					? {
							transformOperationResult: <Value>(operation: string, value: Value): Value =>
								operation === "createCustomer" ? ({ invalid: true } as Value) : value,
						}
					: {}),
			})({
				config: stripeConfig(webhookUrl),
				seed: { customers: [{ name: "Grace" }] },
			}),
		},
	});
}

function createStripeService(webhookUrl: string) {
	return createStripePlugin()({
		config: stripeConfig(webhookUrl),
		seed: { customers: [{ name: "Grace" }] },
	});
}

function createInvalidStripeConfig(kind: "config" | "seed", webhookUrl: string): unknown {
	const envelope =
		kind === "config"
			? { config: { ...stripeConfig(webhookUrl), secretKey: 2137 }, seed: { customers: [] } }
			: {
					config: stripeConfig(webhookUrl),
					seed: { customers: [{ name: 2137 }] },
				};
	return {
		services: {
			stripe: Reflect.apply(createStripePlugin(), undefined, [envelope]),
		},
	};
}

function stripeConfig(webhookUrl: string) {
	return {
		secretKey: "sk_test_local_contract",
		webhookSecret: "whsec_local_contract",
		webhookUrl,
	} as const;
}

function customer(name: string, id = "cus_000001") {
	return Object.freeze({ email: null, id, name });
}

function product() {
	return Object.freeze({ active: true, id: "prod_000001", name: "Pro" });
}

function price() {
	return Object.freeze({
		active: true,
		currency: "usd",
		id: "price_000001",
		productId: "prod_000001",
		unitAmount: 2_500,
	});
}

function subscription() {
	return Object.freeze({
		currentPeriodEnd: "2026-02-01T03:04:05.000Z",
		currentPeriodStart: PINNED_TIME,
		customerId: "cus_000001",
		id: "sub_000001",
		latestInvoiceId: "in_000001",
		priceId: "price_000001",
		status: "active",
	});
}

function invoice() {
	return Object.freeze({
		amountDue: 2_500,
		amountPaid: 2_500,
		currency: "usd",
		customerId: "cus_000001",
		id: "in_000001",
		periodEnd: "2026-02-01T03:04:05.000Z",
		periodStart: PINNED_TIME,
		status: "paid",
		subscriptionId: "sub_000001",
	});
}

function event() {
	return Object.freeze({
		createdAt: PINNED_TIME,
		id: "evt_000001",
		invoiceId: "in_000001",
		type: "invoice.paid",
	});
}

function renewalInvoice() {
	return Object.freeze({
		amountDue: 2_500,
		amountPaid: 2_500,
		currency: "usd",
		customerId: "cus_000001",
		id: "in_000002",
		periodEnd: "2026-03-03T03:04:05.000Z",
		periodStart: "2026-02-01T03:04:05.000Z",
		status: "paid",
		subscriptionId: "sub_000001",
	});
}

function renewalEvent() {
	return Object.freeze({
		createdAt: "2026-02-01T03:04:05.000Z",
		id: "evt_000002",
		invoiceId: "in_000002",
		type: "invoice.paid",
	});
}

function normalizeCustomers(body: unknown) {
	if (typeof body !== "object" || body === null) return body;
	const data = Reflect.get(body, "data");
	if (!Array.isArray(data)) return data;
	return data.map((item) => ({ id: Reflect.get(item, "id"), name: Reflect.get(item, "name") }));
}
