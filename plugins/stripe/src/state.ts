import type { StripeServices } from "./domain/stripe-services.js";
import type { StripeDatabase } from "./persistence/database.js";

export interface StripeState {
	readonly database: StripeDatabase;
	readonly services: StripeServices;
}
