import type { Lifecycle, RunningPluginContext } from "localhost2137";
import type { StripeConfig, StripeSeed } from "./config.js";
import type { StripeTimeAdvance } from "./domain/models.js";
import { createStripeServices, seedStripeServices } from "./domain/stripe-services.js";
import { StripeDatabase } from "./persistence/database.js";
import { assertCurrentDatabaseVersion, migrateDatabase } from "./persistence/migrations.js";
import type { StripePluginDependencies } from "./plugin-dependencies.js";
import type { StripeState } from "./state.js";
import { StripeWebhookDispatcher } from "./webhooks/webhook-dispatcher.js";

type StripeLifecycle = Lifecycle<StripeState, StripeConfig> & {
	readonly onTimeAdvanced: (
		context: RunningPluginContext<StripeState, StripeConfig>,
		advance: StripeTimeAdvance,
	) => Promise<void>;
	readonly seed: (
		context: RunningPluginContext<StripeState, StripeConfig>,
		seed: StripeSeed,
	) => Promise<void> | void;
};

export function createStripeLifecycle(dependencies: StripePluginDependencies): StripeLifecycle {
	return {
		create(context) {
			dependencies.recordLifecycle?.("create");
			dependencies.beforeCreate?.(context);
			withDatabase(context.storage.path("stripe.sqlite"), (database) => {
				migrateDatabase(database.raw());
			});
		},
		async onTimeAdvanced(context, advance) {
			const eventIds = context.state.services.billing.reconcileTimeAdvance(advance);
			await dependencies.afterTimeReconciled?.(context, advance);
			await context.state.webhooks.reconcile(context, eventIds);
		},
		seed(context, seed) {
			dependencies.recordLifecycle?.("seed");
			context.state.database.transaction(() => {
				seedStripeServices(context.state.services, seed, context.clock.now());
			});
		},
		start(context) {
			dependencies.recordLifecycle?.("start");
			const database = new StripeDatabase(context.storage.path("stripe.sqlite"));
			try {
				assertCurrentDatabaseVersion(database.raw());
				return Object.freeze({
					database,
					services: createStripeServices(database, context.config),
					webhooks: new StripeWebhookDispatcher(database, context.config, {
						...(dependencies.webhookDeliveryTimeoutMs === undefined
							? {}
							: { timeoutMs: dependencies.webhookDeliveryTimeoutMs }),
					}),
				});
			} catch (cause) {
				database.close();
				throw cause;
			}
		},
		stop(context) {
			dependencies.recordLifecycle?.("stop");
			dependencies.beforeStop?.(context);
			context.state.database.close();
		},
		update(context, version) {
			dependencies.recordLifecycle?.(`update:${version.from}:${version.to}`);
			withDatabase(context.storage.path("stripe.sqlite"), (database) => {
				migrateDatabase(database.raw());
			});
		},
	};
}

function withDatabase(path: string, work: (database: StripeDatabase) => void): void {
	const database = new StripeDatabase(path);
	try {
		work(database);
	} finally {
		database.close();
	}
}
