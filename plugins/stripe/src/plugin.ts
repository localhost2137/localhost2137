import { type ConnectionMetadata, definePlugin, type PluginFactory } from "localhost2137";
import { createStripeApi } from "./api/routes.js";
import { stripeConfigSchema, stripeSeedSchema } from "./config.js";
import { createStripeLifecycle } from "./lifecycle.js";
import { createStripeOperations } from "./operations.js";
import type { StripePluginDependencies } from "./plugin-dependencies.js";

interface StripeConnection extends ConnectionMetadata {
	readonly env: Readonly<{
		STRIPE_API_URL: string;
		STRIPE_SECRET_KEY: string;
		STRIPE_WEBHOOK_SECRET: string;
	}>;
	readonly values: Readonly<{
		apiUrl: string;
		secretKey: string;
		webhookSecret: string;
	}>;
}

type StripeOperations = ReturnType<typeof createStripeOperations>;

export type StripePluginFactory = PluginFactory<
	typeof stripeConfigSchema,
	typeof stripeSeedSchema,
	StripeOperations,
	StripeConnection
>;

export function createStripePlugin(
	dependencies: StripePluginDependencies = {},
): StripePluginFactory {
	const stateVersion = dependencies.stateVersion ?? 2;
	if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) {
		throw new TypeError("Stripe plugin stateVersion must be a positive safe integer.");
	}
	return definePlugin({
		api: createStripeApi(),
		configSchema: stripeConfigSchema,
		connection: ({ baseUrl, config, instanceId, serviceKey }): StripeConnection => {
			const apiUrl = `${baseUrl}/${instanceId}/${serviceKey}`;
			return Object.freeze({
				env: Object.freeze({
					STRIPE_API_URL: apiUrl,
					STRIPE_SECRET_KEY: config.secretKey,
					STRIPE_WEBHOOK_SECRET: config.webhookSecret,
				}),
				values: Object.freeze({
					apiUrl,
					secretKey: config.secretKey,
					webhookSecret: config.webhookSecret,
				}),
			});
		},
		description: "Stateful Stripe emulator for recurring subscriptions, invoices, and webhooks",
		id: "stripe",
		lifecycle: createStripeLifecycle(dependencies),
		operations: createStripeOperations(dependencies),
		seedSchema: stripeSeedSchema,
		stateVersion,
	});
}
