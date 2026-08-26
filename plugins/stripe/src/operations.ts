import {
	defineOperation,
	LocalhostError,
	type OperationDefinition,
	type RunningPluginContext,
} from "localhost2137";
import { z } from "zod";
import type { StripeConfig } from "./config.js";
import type {
	StripeCustomer,
	StripeEvent,
	StripeInvoice,
	StripePrice,
	StripeProduct,
	StripeSubscription,
} from "./domain/models.js";
import { StripeError } from "./domain/stripe-error.js";
import type { StripePluginDependencies } from "./plugin-dependencies.js";
import type { StripeState } from "./state.js";

const bindOperation = defineOperation<"stripe", StripeState, StripeConfig>();

const createCustomerInput: z.ZodObject<{
	email: z.ZodOptional<z.ZodEmail>;
	name: z.ZodString;
}> = z.object({
	email: z.email().optional(),
	name: z.string().min(1).describe("Customer name"),
});

const customerOutput: z.ZodObject<{
	email: z.ZodNullable<z.ZodString>;
	id: z.ZodString;
	name: z.ZodString;
}> = z.object({ email: z.string().nullable(), id: z.string(), name: z.string() });

const createProductInput: z.ZodObject<{ name: z.ZodString }> = z.object({
	name: z.string().min(1).describe("Product name"),
});

const productOutput: z.ZodObject<{
	active: z.ZodBoolean;
	id: z.ZodString;
	name: z.ZodString;
}> = z.object({ active: z.boolean(), id: z.string(), name: z.string() });

const createPriceInput: z.ZodObject<{
	currency: z.ZodDefault<z.ZodString>;
	productId: z.ZodString;
	unitAmount: z.ZodNumber;
}> = z.object({
	currency: z.string().length(3).default("usd"),
	productId: z.string().min(1).describe("Product ID"),
	unitAmount: z.number().int().nonnegative().describe("Amount in the currency's smallest unit"),
});

const priceOutput: z.ZodObject<{
	active: z.ZodBoolean;
	currency: z.ZodString;
	id: z.ZodString;
	productId: z.ZodString;
	unitAmount: z.ZodNumber;
}> = z.object({
	active: z.boolean(),
	currency: z.string(),
	id: z.string(),
	productId: z.string(),
	unitAmount: z.number(),
});

const createSubscriptionInput: z.ZodObject<{
	customerId: z.ZodString;
	priceId: z.ZodString;
}> = z.object({
	customerId: z.string().min(1).describe("Customer ID"),
	priceId: z.string().min(1).describe("Recurring price ID"),
});

const subscriptionOutput: z.ZodObject<{
	currentPeriodEnd: z.ZodString;
	currentPeriodStart: z.ZodString;
	customerId: z.ZodString;
	id: z.ZodString;
	latestInvoiceId: z.ZodNullable<z.ZodString>;
	priceId: z.ZodString;
	status: z.ZodEnum<{ active: "active"; canceled: "canceled" }>;
}> = z.object({
	currentPeriodEnd: z.string(),
	currentPeriodStart: z.string(),
	customerId: z.string(),
	id: z.string(),
	latestInvoiceId: z.string().nullable(),
	priceId: z.string(),
	status: z.enum(["active", "canceled"]),
});

const listInvoicesInput: z.ZodObject<{
	customerId: z.ZodOptional<z.ZodString>;
	subscriptionId: z.ZodOptional<z.ZodString>;
}> = z.object({
	customerId: z.string().min(1).optional(),
	subscriptionId: z.string().min(1).optional(),
});

const invoiceOutput: z.ZodObject<{
	amountDue: z.ZodNumber;
	amountPaid: z.ZodNumber;
	currency: z.ZodString;
	customerId: z.ZodString;
	id: z.ZodString;
	periodEnd: z.ZodString;
	periodStart: z.ZodString;
	status: z.ZodEnum<{ open: "open"; paid: "paid" }>;
	subscriptionId: z.ZodString;
}> = z.object({
	amountDue: z.number(),
	amountPaid: z.number(),
	currency: z.string(),
	customerId: z.string(),
	id: z.string(),
	periodEnd: z.string(),
	periodStart: z.string(),
	status: z.enum(["open", "paid"]),
	subscriptionId: z.string(),
});

const invoiceListOutput: z.ZodArray<typeof invoiceOutput> = z.array(invoiceOutput);

const listEventsInput: z.ZodObject<{
	type: z.ZodOptional<
		z.ZodEnum<{
			"invoice.paid": "invoice.paid";
			"invoice.payment_failed": "invoice.payment_failed";
		}>
	>;
}> = z.object({ type: z.enum(["invoice.paid", "invoice.payment_failed"]).optional() });

const eventOutput: z.ZodObject<{
	createdAt: z.ZodString;
	id: z.ZodString;
	invoiceId: z.ZodString;
	type: z.ZodEnum<{
		"invoice.paid": "invoice.paid";
		"invoice.payment_failed": "invoice.payment_failed";
	}>;
}> = z.object({
	createdAt: z.string(),
	id: z.string(),
	invoiceId: z.string(),
	type: z.enum(["invoice.paid", "invoice.payment_failed"]),
});

const eventListOutput: z.ZodArray<typeof eventOutput> = z.array(eventOutput);

const setPaymentOutcomeInput: z.ZodObject<{
	outcome: z.ZodEnum<{ failed: "failed"; succeeded: "succeeded" }>;
	subscriptionId: z.ZodString;
}> = z.object({
	outcome: z.enum(["succeeded", "failed"]),
	subscriptionId: z.string().min(1),
});

const paymentOutcomeOutput: z.ZodObject<{
	outcome: z.ZodEnum<{ failed: "failed"; succeeded: "succeeded" }>;
	subscriptionId: z.ZodString;
}> = z.object({ outcome: z.enum(["succeeded", "failed"]), subscriptionId: z.string() });

type StripeBoundOperation<
	Input extends z.ZodObject,
	Output extends z.ZodType,
> = OperationDefinition<"stripe", StripeState, StripeConfig, Input, Output>;

interface StripeOperations {
	readonly createCustomer: StripeBoundOperation<typeof createCustomerInput, typeof customerOutput>;
	readonly createPrice: StripeBoundOperation<typeof createPriceInput, typeof priceOutput>;
	readonly createProduct: StripeBoundOperation<typeof createProductInput, typeof productOutput>;
	readonly createSubscription: StripeBoundOperation<
		typeof createSubscriptionInput,
		typeof subscriptionOutput
	>;
	readonly listEvents: StripeBoundOperation<typeof listEventsInput, typeof eventListOutput>;
	readonly listInvoices: StripeBoundOperation<typeof listInvoicesInput, typeof invoiceListOutput>;
	readonly setNextPaymentOutcome: StripeBoundOperation<
		typeof setPaymentOutcomeInput,
		typeof paymentOutcomeOutput
	>;
}

export function createStripeOperations(
	dependencies: StripePluginDependencies,
): Readonly<StripeOperations> {
	const createCustomer = bindOperation({
		description: "Create a customer in the local Stripe account",
		input: createCustomerInput,
		output: customerOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "createCustomer", context, () =>
				customerDto(
					context.state.services.customers.create({
						...(input.email ? { email: input.email } : {}),
						name: input.name,
						now: context.clock.now(),
					}),
				),
			),
	});

	const createProduct = bindOperation({
		description: "Create a recurring product in the local Stripe catalog",
		input: createProductInput,
		output: productOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "createProduct", context, () =>
				productDto(
					context.state.services.catalog.createProduct({
						name: input.name,
						now: context.clock.now(),
					}),
				),
			),
	});

	const createPrice = bindOperation({
		description: "Create a fixed monthly price in the local Stripe catalog",
		input: createPriceInput,
		output: priceOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "createPrice", context, () =>
				priceDto(
					context.state.services.catalog.createPrice({
						currency: input.currency,
						now: context.clock.now(),
						productId: input.productId,
						unitAmount: input.unitAmount,
					}),
				),
			),
	});

	const createSubscription = bindOperation({
		description: "Create a local monthly subscription and its first invoice",
		input: createSubscriptionInput,
		output: subscriptionOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "createSubscription", context, () =>
				subscriptionDto(
					context.state.services.billing.createSubscription({
						customerId: input.customerId,
						now: context.clock.now(),
						priceId: input.priceId,
					}).subscription,
				),
			),
	});

	const listInvoices = bindOperation({
		description: "Inspect invoices in the local Stripe account",
		input: listInvoicesInput,
		output: invoiceListOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "listInvoices", context, () =>
				context.state.services.billing
					.listInvoices({
						...(input.customerId ? { customerId: input.customerId } : {}),
						...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
					})
					.map(invoiceDto),
			),
	});

	const listEvents = bindOperation({
		description: "Inspect generated events in the local Stripe account",
		input: listEventsInput,
		output: eventListOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "listEvents", context, () =>
				context.state.services.billing
					.listEvents(input.type ? { type: input.type } : {})
					.map(eventDto),
			),
	});

	const setNextPaymentOutcome = bindOperation({
		description: "Set the deterministic outcome of a subscription's next invoice payment",
		input: setPaymentOutcomeInput,
		output: paymentOutcomeOutput,
		run: (context, input) =>
			runStripeOperation(dependencies, "setNextPaymentOutcome", context, () => {
				context.state.services.billing.setNextPaymentOutcome(input.subscriptionId, input.outcome);
				return { outcome: input.outcome, subscriptionId: input.subscriptionId };
			}),
	});

	return Object.freeze({
		createCustomer,
		createPrice,
		createProduct,
		createSubscription,
		listEvents,
		listInvoices,
		setNextPaymentOutcome,
	});
}

function customerDto(customer: StripeCustomer): z.output<typeof customerOutput> {
	return { email: customer.email, id: customer.id, name: customer.name };
}

function productDto(product: StripeProduct): z.output<typeof productOutput> {
	return { active: product.active, id: product.id, name: product.name };
}

function priceDto(price: StripePrice): z.output<typeof priceOutput> {
	return {
		active: price.active,
		currency: price.currency,
		id: price.id,
		productId: price.productId,
		unitAmount: price.unitAmount,
	};
}

function subscriptionDto(subscription: StripeSubscription): z.output<typeof subscriptionOutput> {
	return {
		currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
		currentPeriodStart: subscription.currentPeriodStart.toISOString(),
		customerId: subscription.customerId,
		id: subscription.id,
		latestInvoiceId: subscription.latestInvoiceId,
		priceId: subscription.priceId,
		status: subscription.status,
	};
}

function invoiceDto(invoice: StripeInvoice): z.output<typeof invoiceOutput> {
	return {
		amountDue: invoice.amountDue,
		amountPaid: invoice.amountPaid,
		currency: invoice.currency,
		customerId: invoice.customerId,
		id: invoice.id,
		periodEnd: invoice.periodEnd.toISOString(),
		periodStart: invoice.periodStart.toISOString(),
		status: invoice.status,
		subscriptionId: invoice.subscriptionId,
	};
}

function eventDto(event: StripeEvent): z.output<typeof eventOutput> {
	return {
		createdAt: event.createdAt.toISOString(),
		id: event.id,
		invoiceId: event.invoiceId,
		type: event.type,
	};
}

function runStripeOperation<Value>(
	dependencies: StripePluginDependencies,
	operation: string,
	context: RunningPluginContext<StripeState, StripeConfig>,
	run: () => Value,
): Value {
	dependencies.beforeOperation?.(operation, context);
	try {
		return dependencies.transformOperationResult
			? dependencies.transformOperationResult(operation, run())
			: run();
	} catch (cause) {
		if (!(cause instanceof StripeError)) throw cause;
		throw new LocalhostError(`STRIPE_${cause.code.toUpperCase()}`, cause.message, {
			cause,
			details: { stripeError: cause.code },
			status: stripeOperationStatus(cause),
		});
	}
}

function stripeOperationStatus(error: StripeError): number {
	if (error.code.endsWith("_missing")) return 404;
	if (error.code === "advance_conflict" || error.code === "subscription_canceled") return 409;
	return 400;
}
