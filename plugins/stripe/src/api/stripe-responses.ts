import type {
	StripeCustomer,
	StripeInvoice,
	StripePrice,
	StripeProduct,
	StripeSubscription,
} from "../domain/models.js";

export function stripeCustomer(customer: StripeCustomer): Readonly<Record<string, unknown>> {
	return Object.freeze({
		created: unixSeconds(customer.createdAt),
		email: customer.email,
		id: customer.id,
		livemode: false,
		name: customer.name,
		object: "customer",
	});
}

export function stripeProduct(product: StripeProduct): Readonly<Record<string, unknown>> {
	return Object.freeze({
		active: product.active,
		created: unixSeconds(product.createdAt),
		id: product.id,
		livemode: false,
		name: product.name,
		object: "product",
	});
}

export function stripePrice(price: StripePrice): Readonly<Record<string, unknown>> {
	return Object.freeze({
		active: price.active,
		created: unixSeconds(price.createdAt),
		currency: price.currency,
		id: price.id,
		livemode: false,
		object: "price",
		product: price.productId,
		recurring: Object.freeze({ interval: "month", interval_count: 1 }),
		type: "recurring",
		unit_amount: price.unitAmount,
		unit_amount_decimal: String(price.unitAmount),
	});
}

export function stripeSubscription(
	subscription: StripeSubscription,
	price: StripePrice,
): Readonly<Record<string, unknown>> {
	const item = Object.freeze({
		created: unixSeconds(subscription.createdAt),
		id: subscription.itemId,
		object: "subscription_item",
		price: stripePrice(price),
		quantity: 1,
		subscription: subscription.id,
	});
	return Object.freeze({
		cancel_at_period_end: false,
		canceled_at: subscription.canceledAt ? unixSeconds(subscription.canceledAt) : null,
		created: unixSeconds(subscription.createdAt),
		currency: price.currency,
		current_period_end: unixSeconds(subscription.currentPeriodEnd),
		current_period_start: unixSeconds(subscription.currentPeriodStart),
		customer: subscription.customerId,
		id: subscription.id,
		items: stripeList([item], `/v1/subscription_items?subscription=${subscription.id}`),
		latest_invoice: subscription.latestInvoiceId,
		livemode: false,
		object: "subscription",
		status: subscription.status,
	});
}

export function stripeInvoice(
	invoice: StripeInvoice,
	price: StripePrice,
): Readonly<Record<string, unknown>> {
	const line = Object.freeze({
		amount: invoice.amountDue,
		currency: invoice.currency,
		id: `il_${invoice.id.slice("in_".length)}`,
		object: "line_item",
		period: Object.freeze({
			end: unixSeconds(invoice.periodEnd),
			start: unixSeconds(invoice.periodStart),
		}),
		price: stripePrice(price),
		quantity: 1,
		subscription: invoice.subscriptionId,
	});
	return Object.freeze({
		amount_due: invoice.amountDue,
		amount_paid: invoice.amountPaid,
		amount_remaining: invoice.amountDue - invoice.amountPaid,
		created: unixSeconds(invoice.createdAt),
		currency: invoice.currency,
		customer: invoice.customerId,
		id: invoice.id,
		lines: stripeList([line], `/v1/invoices/${invoice.id}/lines`),
		livemode: false,
		object: "invoice",
		paid: invoice.status === "paid",
		period_end: unixSeconds(invoice.periodEnd),
		period_start: unixSeconds(invoice.periodStart),
		status: invoice.status,
		subscription: invoice.subscriptionId,
	});
}

export function stripeList(
	data: readonly Readonly<Record<string, unknown>>[],
	url: string,
	hasMore = false,
): Readonly<Record<string, unknown>> {
	return Object.freeze({ data: Object.freeze(data), has_more: hasMore, object: "list", url });
}

function unixSeconds(value: Date): number {
	return Math.floor(value.getTime() / 1_000);
}
