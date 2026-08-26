import { createStripeSdkFetch } from "@localhost2137/stripe";
import Stripe from "stripe";

export interface LocalStripeConnection {
	readonly apiUrl: string;
	readonly secretKey: string;
}

/** Builds the official Stripe SDK against one localhost2137 instance-scoped account. */
export function createLocalStripe(connection: LocalStripeConnection): Stripe {
	return new Stripe(connection.secretKey, {
		httpClient: Stripe.createFetchHttpClient(createStripeSdkFetch(connection.apiUrl)),
		maxNetworkRetries: 0,
	});
}
