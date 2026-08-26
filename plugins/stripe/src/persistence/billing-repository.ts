import type Database from "better-sqlite3";
import type {
	PaymentOutcome,
	StripeInvoice,
	StripeSubscription,
	SubscriptionId,
} from "../domain/models.js";
import { insertStripeId } from "./id-sequence.js";

interface SubscriptionRow {
	readonly canceled_at_ms: number | null;
	readonly created_at_ms: number;
	readonly current_period_end_ms: number;
	readonly current_period_start_ms: number;
	readonly customer_id: string;
	readonly id: string;
	readonly item_id: string;
	readonly latest_invoice_id: string | null;
	readonly price_id: string;
	readonly status: "active" | "canceled";
}

interface InvoiceRow {
	readonly amount_due: number;
	readonly amount_paid: number;
	readonly created_at_ms: number;
	readonly currency: string;
	readonly customer_id: string;
	readonly id: string;
	readonly paid_at_ms: number | null;
	readonly period_end_ms: number;
	readonly period_start_ms: number;
	readonly price_id: string;
	readonly status: "open" | "paid";
	readonly subscription_id: string;
}

export interface StoredTimeAdvance {
	readonly advanceId: string;
	readonly fromMs: number;
	readonly toMs: number;
}

export class BillingRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	cancelSubscription(id: SubscriptionId, now: Date): StripeSubscription {
		const result = this.#database
			.prepare(
				`UPDATE subscriptions SET status = 'canceled', canceled_at_ms = ?
				 WHERE id = ? AND status = 'active'`,
			)
			.run(now.getTime(), id);
		if (result.changes !== 1) throw new Error(`Stripe subscription ${id} is not active.`);
		return this.getSubscription(id);
	}

	consumeNextPaymentOutcome(subscriptionId: SubscriptionId): PaymentOutcome {
		const row = this.#database
			.prepare("SELECT outcome FROM next_payment_outcomes WHERE subscription_id = ?")
			.get(subscriptionId) as { outcome: PaymentOutcome } | undefined;
		if (!row) return "succeeded";
		this.#database
			.prepare("DELETE FROM next_payment_outcomes WHERE subscription_id = ?")
			.run(subscriptionId);
		return row.outcome;
	}

	createInvoice(
		input: Readonly<{
			amount: number;
			currency: string;
			customerId: string;
			now: Date;
			outcome: PaymentOutcome;
			periodEnd: Date;
			periodStart: Date;
			priceId: string;
			subscriptionId: string;
		}>,
	): StripeInvoice {
		const id = insertStripeId(this.#database, "invoice", undefined, (allocatedId) => {
			const succeeded = input.outcome === "succeeded";
			this.#database
				.prepare(
					`INSERT INTO invoices(
						id, subscription_id, customer_id, price_id, currency,
						amount_due, amount_paid, status, period_start_ms, period_end_ms,
						created_at_ms, paid_at_ms
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					allocatedId,
					input.subscriptionId,
					input.customerId,
					input.priceId,
					input.currency,
					input.amount,
					succeeded ? input.amount : 0,
					succeeded ? "paid" : "open",
					input.periodStart.getTime(),
					input.periodEnd.getTime(),
					input.now.getTime(),
					succeeded ? input.now.getTime() : null,
				);
		});
		return this.getInvoice(id);
	}

	createSubscription(
		input: Readonly<{
			customerId: string;
			now: Date;
			periodEnd: Date;
			priceId: string;
		}>,
	): StripeSubscription {
		const id = insertStripeId(this.#database, "subscription", undefined, (allocatedId) => {
			const itemId = `si_${allocatedId.slice("sub_".length)}`;
			this.#database
				.prepare(
					`INSERT INTO subscriptions(
						id, item_id, customer_id, price_id, status,
						current_period_start_ms, current_period_end_ms, created_at_ms
					 ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
				)
				.run(
					allocatedId,
					itemId,
					input.customerId,
					input.priceId,
					input.now.getTime(),
					input.periodEnd.getTime(),
					input.now.getTime(),
				);
		});
		return this.getSubscription(id);
	}

	findInvoice(id: string): StripeInvoice | undefined {
		const row = this.#database.prepare(`${invoiceSelect} WHERE id = ?`).get(id) as
			| InvoiceRow
			| undefined;
		return row ? toInvoice(row) : undefined;
	}

	findSubscription(id: string): StripeSubscription | undefined {
		const row = this.#database.prepare(`${subscriptionSelect} WHERE id = ?`).get(id) as
			| SubscriptionRow
			| undefined;
		return row ? toSubscription(row) : undefined;
	}

	findTimeAdvance(advanceId: string): StoredTimeAdvance | undefined {
		const row = this.#database
			.prepare("SELECT advance_id, from_ms, to_ms FROM time_advances WHERE advance_id = ?")
			.get(advanceId) as { advance_id: string; from_ms: number; to_ms: number } | undefined;
		return row
			? Object.freeze({ advanceId: row.advance_id, fromMs: row.from_ms, toMs: row.to_ms })
			: undefined;
	}

	getInvoice(id: string): StripeInvoice {
		const invoice = this.findInvoice(id);
		if (!invoice) throw new Error(`Stripe invoice ${id} is missing after persistence.`);
		return invoice;
	}

	getSubscription(id: string): StripeSubscription {
		const subscription = this.findSubscription(id);
		if (!subscription) throw new Error(`Stripe subscription ${id} is missing after persistence.`);
		return subscription;
	}

	listDueSubscriptions(through: Date): readonly StripeSubscription[] {
		const rows = this.#database
			.prepare(
				`${subscriptionSelect}
				 WHERE status = 'active' AND current_period_end_ms <= ?
				 ORDER BY current_period_end_ms, id`,
			)
			.all(through.getTime()) as SubscriptionRow[];
		return Object.freeze(rows.map(toSubscription));
	}

	listInvoices(
		input: Readonly<{ customerId?: string; subscriptionId?: string }> = {},
	): readonly StripeInvoice[] {
		const conditions: string[] = [];
		const parameters: string[] = [];
		if (input.customerId) {
			conditions.push("customer_id = ?");
			parameters.push(input.customerId);
		}
		if (input.subscriptionId) {
			conditions.push("subscription_id = ?");
			parameters.push(input.subscriptionId);
		}
		const rows = this.#database
			.prepare(
				`${invoiceSelect}${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}
				 ORDER BY id`,
			)
			.all(...parameters) as InvoiceRow[];
		return Object.freeze(rows.map(toInvoice));
	}

	recordTimeAdvance(input: StoredTimeAdvance & Readonly<{ processedAt: Date }>): void {
		this.#database
			.prepare(
				"INSERT INTO time_advances(advance_id, from_ms, to_ms, processed_at_ms) VALUES (?, ?, ?, ?)",
			)
			.run(input.advanceId, input.fromMs, input.toMs, input.processedAt.getTime());
	}

	setLatestInvoice(subscriptionId: SubscriptionId, invoiceId: string): void {
		const result = this.#database
			.prepare("UPDATE subscriptions SET latest_invoice_id = ? WHERE id = ?")
			.run(invoiceId, subscriptionId);
		if (result.changes !== 1) throw new Error(`Stripe subscription ${subscriptionId} is missing.`);
	}

	setNextPaymentOutcome(subscriptionId: SubscriptionId, outcome: PaymentOutcome): void {
		this.#database
			.prepare(
				`INSERT INTO next_payment_outcomes(subscription_id, outcome) VALUES (?, ?)
				 ON CONFLICT(subscription_id) DO UPDATE SET outcome = excluded.outcome`,
			)
			.run(subscriptionId, outcome);
	}

	updatePeriod(
		subscriptionId: SubscriptionId,
		input: Readonly<{ end: Date; latestInvoiceId: string; start: Date }>,
	): StripeSubscription {
		const result = this.#database
			.prepare(
				`UPDATE subscriptions
				 SET current_period_start_ms = ?, current_period_end_ms = ?, latest_invoice_id = ?
				 WHERE id = ? AND status = 'active'`,
			)
			.run(input.start.getTime(), input.end.getTime(), input.latestInvoiceId, subscriptionId);
		if (result.changes !== 1)
			throw new Error(`Stripe subscription ${subscriptionId} is not active.`);
		return this.getSubscription(subscriptionId);
	}
}

const subscriptionSelect = `SELECT
	id, item_id, customer_id, price_id, status, current_period_start_ms,
	current_period_end_ms, latest_invoice_id, created_at_ms, canceled_at_ms
FROM subscriptions`;

const invoiceSelect = `SELECT
	id, subscription_id, customer_id, price_id, currency, amount_due, amount_paid,
	status, period_start_ms, period_end_ms, created_at_ms, paid_at_ms
FROM invoices`;

function toSubscription(row: SubscriptionRow): StripeSubscription {
	return Object.freeze({
		canceledAt: row.canceled_at_ms === null ? null : new Date(row.canceled_at_ms),
		createdAt: new Date(row.created_at_ms),
		currentPeriodEnd: new Date(row.current_period_end_ms),
		currentPeriodStart: new Date(row.current_period_start_ms),
		customerId: row.customer_id,
		id: row.id,
		itemId: row.item_id,
		latestInvoiceId: row.latest_invoice_id,
		priceId: row.price_id,
		status: row.status,
	});
}

function toInvoice(row: InvoiceRow): StripeInvoice {
	return Object.freeze({
		amountDue: row.amount_due,
		amountPaid: row.amount_paid,
		createdAt: new Date(row.created_at_ms),
		currency: row.currency,
		customerId: row.customer_id,
		id: row.id,
		paidAt: row.paid_at_ms === null ? null : new Date(row.paid_at_ms),
		periodEnd: new Date(row.period_end_ms),
		periodStart: new Date(row.period_start_ms),
		priceId: row.price_id,
		status: row.status,
		subscriptionId: row.subscription_id,
	});
}
