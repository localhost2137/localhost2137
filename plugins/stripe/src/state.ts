import type { StripeServices } from "./domain/stripe-services.js";
import type { StripeDatabase } from "./persistence/database.js";
import type { StripeWebhookDispatcher } from "./webhooks/webhook-dispatcher.js";

export interface StripeState {
	readonly database: StripeDatabase;
	readonly services: StripeServices;
	readonly webhooks: StripeWebhookDispatcher;
}
