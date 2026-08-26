import { stripeInvoice } from "../api/stripe-responses.js";
import type { StripeEvent, StripeInvoice, StripePrice } from "../domain/models.js";

export function createStripeEventEnvelope(
	event: StripeEvent,
	invoice: StripeInvoice,
	price: StripePrice,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		api_version: "2026-08-20.localhost2137",
		created: Math.floor(event.createdAt.getTime() / 1_000),
		data: Object.freeze({ object: stripeInvoice(invoice, price) }),
		id: event.id,
		livemode: false,
		object: "event",
		pending_webhooks: 1,
		request: Object.freeze({ id: null, idempotency_key: null }),
		type: event.type,
	});
}
