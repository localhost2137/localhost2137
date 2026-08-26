import type { StripeDatabase } from "../persistence/database.js";
import type { CatalogService } from "./catalog-service.js";
import type { CustomerService } from "./customer-service.js";
import type {
	PaymentOutcome,
	StripeEvent,
	StripeInvoice,
	StripeSubscription,
	StripeTimeAdvance,
} from "./models.js";
import { StripeError } from "./stripe-error.js";

export const BILLING_PERIOD_MS: number = 30 * 24 * 60 * 60 * 1_000;

const MINIMUM_DATE_MS = -8_640_000_000_000_000n;
const MAXIMUM_DATE_MS = 8_640_000_000_000_000n;

export interface CreatedSubscription {
	readonly event: StripeEvent;
	readonly invoice: StripeInvoice;
	readonly subscription: StripeSubscription;
}

export class BillingService {
	readonly #catalog: CatalogService;
	readonly #customers: CustomerService;
	readonly #database: StripeDatabase;
	readonly #emitWebhooks: boolean;

	constructor(
		database: StripeDatabase,
		dependencies: Readonly<{
			catalog: CatalogService;
			customers: CustomerService;
			emitWebhooks: boolean;
		}>,
	) {
		this.#catalog = dependencies.catalog;
		this.#customers = dependencies.customers;
		this.#database = database;
		this.#emitWebhooks = dependencies.emitWebhooks;
	}

	cancelSubscription(id: string, now: Date): StripeSubscription {
		const subscription = this.requireSubscription(id);
		if (subscription.status === "canceled") return subscription;
		return this.#database.billing.cancelSubscription(id, now);
	}

	createSubscription(
		input: Readonly<{ customerId: string; now: Date; priceId: string }>,
	): CreatedSubscription {
		return this.#database.transaction(() => {
			this.#customers.require(input.customerId);
			const price = this.#catalog.requirePrice(input.priceId);
			const subscription = this.#database.billing.createSubscription({
				customerId: input.customerId,
				now: input.now,
				periodEnd: addBillingPeriod(input.now),
				priceId: price.id,
			});
			const issued = this.#issueInvoice(subscription, input.now);
			return Object.freeze({
				event: issued.event,
				invoice: issued.invoice,
				subscription: this.#database.billing.getSubscription(subscription.id),
			});
		});
	}

	listEvents(input?: Readonly<{ type?: StripeEvent["type"] }>): readonly StripeEvent[] {
		return this.#database.events.list(input);
	}

	listInvoices(
		input?: Readonly<{ customerId?: string; subscriptionId?: string }>,
	): readonly StripeInvoice[] {
		return this.#database.billing.listInvoices(input);
	}

	pendingWebhookEventIds(input?: Readonly<{ advanceId?: string }>): readonly string[] {
		return this.#database.events.pendingIds(input);
	}

	reconcileTimeAdvance(advance: StripeTimeAdvance): readonly string[] {
		const fromMs = dateMilliseconds(advance.from, "from");
		const toMs = dateMilliseconds(advance.to, "to");
		if (toMs <= fromMs) {
			throw new StripeError(
				"invalid_argument",
				"Stripe time advances must end after they start.",
				"to",
			);
		}
		return this.#database.transaction(() => {
			const existing = this.#database.billing.findTimeAdvance(advance.advanceId);
			if (existing) {
				if (existing.fromMs !== fromMs || existing.toMs !== toMs) {
					throw new StripeError(
						"advance_conflict",
						`Stripe time advance ${advance.advanceId} was already processed with a different range.`,
					);
				}
				return this.#database.events.pendingIds({ advanceId: advance.advanceId });
			}

			for (const due of this.#database.billing.listDueSubscriptions(advance.to)) {
				let subscription = due;
				while (subscription.currentPeriodEnd.getTime() <= toMs) {
					const nextStart = subscription.currentPeriodEnd;
					const nextEnd = addBillingPeriod(nextStart);
					const issued = this.#issueInvoice(subscription, nextStart, advance.advanceId, {
						end: nextEnd,
						start: nextStart,
					});
					subscription = this.#database.billing.updatePeriod(subscription.id, {
						end: nextEnd,
						latestInvoiceId: issued.invoice.id,
						start: nextStart,
					});
				}
			}
			this.#database.billing.recordTimeAdvance({
				advanceId: advance.advanceId,
				fromMs,
				processedAt: advance.to,
				toMs,
			});
			return this.#database.events.pendingIds({ advanceId: advance.advanceId });
		});
	}

	requireInvoice(id: string): StripeInvoice {
		const invoice = this.#database.billing.findInvoice(id);
		if (!invoice) throw new StripeError("invalid_argument", `No such invoice: '${id}'.`, "invoice");
		return invoice;
	}

	requireSubscription(id: string): StripeSubscription {
		const subscription = this.#database.billing.findSubscription(id);
		if (!subscription) {
			throw new StripeError(
				"subscription_missing",
				`No such subscription: '${id}'.`,
				"subscription",
			);
		}
		return subscription;
	}

	setNextPaymentOutcome(subscriptionId: string, outcome: PaymentOutcome): void {
		const subscription = this.requireSubscription(subscriptionId);
		if (subscription.status !== "active") {
			throw new StripeError(
				"subscription_canceled",
				`Subscription ${subscriptionId} is canceled.`,
				"subscription",
			);
		}
		this.#database.billing.setNextPaymentOutcome(subscriptionId, outcome);
	}

	#issueInvoice(
		subscription: StripeSubscription,
		now: Date,
		advanceId?: string,
		period: Readonly<{ end: Date; start: Date }> = {
			end: subscription.currentPeriodEnd,
			start: subscription.currentPeriodStart,
		},
	): Readonly<{ event: StripeEvent; invoice: StripeInvoice }> {
		const price = this.#catalog.requirePrice(subscription.priceId);
		const outcome = this.#database.billing.consumeNextPaymentOutcome(subscription.id);
		const invoice = this.#database.billing.createInvoice({
			amount: price.unitAmount,
			currency: price.currency,
			customerId: subscription.customerId,
			now,
			outcome,
			periodEnd: period.end,
			periodStart: period.start,
			priceId: price.id,
			subscriptionId: subscription.id,
		});
		this.#database.billing.setLatestInvoice(subscription.id, invoice.id);
		const event = this.#database.events.create({
			...(advanceId ? { advanceId } : {}),
			emitWebhook: this.#emitWebhooks,
			invoiceId: invoice.id,
			now,
			type: outcome === "succeeded" ? "invoice.paid" : "invoice.payment_failed",
		});
		return Object.freeze({ event, invoice });
	}
}

function addBillingPeriod(value: Date): Date {
	const next = BigInt(dateMilliseconds(value, "date")) + BigInt(BILLING_PERIOD_MS);
	if (next < MINIMUM_DATE_MS || next > MAXIMUM_DATE_MS) {
		throw new RangeError("Stripe billing period exceeds the JavaScript Date range.");
	}
	return new Date(Number(next));
}

function dateMilliseconds(value: Date, parameter: string): number {
	const milliseconds = value.getTime();
	if (!Number.isSafeInteger(milliseconds)) {
		throw new StripeError(
			"invalid_argument",
			`Stripe ${parameter} must be a valid Date.`,
			parameter,
		);
	}
	return milliseconds;
}
