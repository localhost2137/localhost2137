export type CustomerId = string;
export type EventId = string;
export type InvoiceId = string;
type PriceId = string;
export type ProductId = string;
export type SubscriptionId = string;

export interface StripeCustomer {
	readonly createdAt: Date;
	readonly email: string | null;
	readonly id: CustomerId;
	readonly name: string;
}

export interface StripeProduct {
	readonly active: boolean;
	readonly createdAt: Date;
	readonly id: ProductId;
	readonly name: string;
}

export interface StripePrice {
	readonly active: boolean;
	readonly createdAt: Date;
	readonly currency: string;
	readonly id: PriceId;
	readonly productId: ProductId;
	readonly unitAmount: number;
}

export interface StripeSubscription {
	readonly canceledAt: Date | null;
	readonly createdAt: Date;
	readonly currentPeriodEnd: Date;
	readonly currentPeriodStart: Date;
	readonly customerId: CustomerId;
	readonly id: SubscriptionId;
	readonly itemId: string;
	readonly latestInvoiceId: InvoiceId | null;
	readonly priceId: PriceId;
	readonly status: "active" | "canceled";
}

export interface StripeInvoice {
	readonly amountDue: number;
	readonly amountPaid: number;
	readonly createdAt: Date;
	readonly currency: string;
	readonly customerId: CustomerId;
	readonly id: InvoiceId;
	readonly paidAt: Date | null;
	readonly periodEnd: Date;
	readonly periodStart: Date;
	readonly priceId: PriceId;
	readonly status: "open" | "paid";
	readonly subscriptionId: SubscriptionId;
}

export interface StripeEvent {
	readonly advanceId: string | null;
	readonly createdAt: Date;
	readonly id: EventId;
	readonly invoiceId: InvoiceId;
	readonly type: "invoice.paid" | "invoice.payment_failed";
}

export interface StripeTimeAdvance {
	readonly advanceId: string;
	readonly from: Date;
	readonly to: Date;
}

export type PaymentOutcome = "failed" | "succeeded";
