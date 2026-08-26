import { type Context, Hono } from "hono";
import type { PluginEnv } from "localhost2137";
import type { StripeConfig } from "../config.js";
import { StripeError } from "../domain/stripe-error.js";
import type { StripeState } from "../state.js";
import {
	listParameters,
	optionalString,
	readStripeRequest,
	requiredString,
} from "./stripe-request.js";
import {
	stripeCustomer,
	stripeInvoice,
	stripeList,
	stripePrice,
	stripeProduct,
	stripeSubscription,
} from "./stripe-responses.js";

type StripeContext = Context<PluginEnv<StripeState, StripeConfig>>;
type StripeHandler = (context: StripeContext) => Promise<Response>;

export function createStripeApi(): Hono<PluginEnv<StripeState, StripeConfig>> {
	const api = new Hono<PluginEnv<StripeState, StripeConfig>>();
	api.post("/v1/customers", stripeMethod(createCustomer));
	api.get("/v1/customers", stripeMethod(listCustomers));
	api.get("/v1/customers/:id", stripeMethod(retrieveCustomer));
	api.get("/v1/products", stripeMethod(listProducts));
	api.get("/v1/products/:id", stripeMethod(retrieveProduct));
	api.get("/v1/prices", stripeMethod(listPrices));
	api.get("/v1/prices/:id", stripeMethod(retrievePrice));
	api.post("/v1/subscriptions", stripeMethod(createSubscription));
	api.get("/v1/subscriptions/:id", stripeMethod(retrieveSubscription));
	api.delete("/v1/subscriptions/:id", stripeMethod(cancelSubscription));
	api.get("/v1/invoices", stripeMethod(listInvoices));
	api.get("/v1/invoices/:id", stripeMethod(retrieveInvoice));
	return api;
}

async function createCustomer(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const email = optionalString(request, "email");
	const customer = runtime.state.services.customers.create({
		...(email ? { email } : {}),
		name: requiredString(request, "name"),
		now: runtime.clock.now(),
	});
	return context.json(stripeCustomer(customer));
}

async function listCustomers(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const parameters = listParameters(request);
	const result = runtime.state.services.customers.list({
		...(parameters.afterId ? { afterId: parameters.afterId } : {}),
		limit: parameters.limit + 1,
	});
	return context.json(
		stripeList(
			result.slice(0, parameters.limit).map(stripeCustomer),
			"/v1/customers",
			result.length > parameters.limit,
		),
	);
}

async function retrieveCustomer(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	return context.json(
		stripeCustomer(context.get("lh").state.services.customers.require(pathId(context))),
	);
}

async function listProducts(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const parameters = listParameters(request);
	const result = runtime.state.services.catalog.listProducts({
		...(parameters.afterId ? { afterId: parameters.afterId } : {}),
		limit: parameters.limit + 1,
	});
	return context.json(
		stripeList(
			result.slice(0, parameters.limit).map(stripeProduct),
			"/v1/products",
			result.length > parameters.limit,
		),
	);
}

async function retrieveProduct(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	return context.json(
		stripeProduct(context.get("lh").state.services.catalog.requireProduct(pathId(context))),
	);
}

async function listPrices(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const parameters = listParameters(request);
	const result = runtime.state.services.catalog.listPrices({
		...(parameters.afterId ? { afterId: parameters.afterId } : {}),
		limit: parameters.limit + 1,
	});
	return context.json(
		stripeList(
			result.slice(0, parameters.limit).map(stripePrice),
			"/v1/prices",
			result.length > parameters.limit,
		),
	);
}

async function retrievePrice(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	return context.json(
		stripePrice(context.get("lh").state.services.catalog.requirePrice(pathId(context))),
	);
}

async function createSubscription(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const created = runtime.state.services.billing.createSubscription({
		customerId: requiredString(request, "customer"),
		now: runtime.clock.now(),
		priceId: requiredString(request, "items[0][price]"),
	});
	runtime.state.webhooks.schedule(runtime, created.event.id);
	const price = runtime.state.services.catalog.requirePrice(created.subscription.priceId);
	return context.json(stripeSubscription(created.subscription, price));
}

async function retrieveSubscription(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	const runtime = context.get("lh");
	const subscription = runtime.state.services.billing.requireSubscription(pathId(context));
	return context.json(
		stripeSubscription(
			subscription,
			runtime.state.services.catalog.requirePrice(subscription.priceId),
		),
	);
}

async function cancelSubscription(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	const runtime = context.get("lh");
	const subscription = runtime.state.services.billing.cancelSubscription(
		pathId(context),
		runtime.clock.now(),
	);
	return context.json(
		stripeSubscription(
			subscription,
			runtime.state.services.catalog.requirePrice(subscription.priceId),
		),
	);
}

async function listInvoices(context: StripeContext): Promise<Response> {
	const request = await readStripeRequest(context);
	const runtime = context.get("lh");
	const parameters = listParameters(request);
	const customerId = optionalString(request, "customer");
	const subscriptionId = optionalString(request, "subscription");
	const invoices = runtime.state.services.billing.listInvoices({
		...(parameters.afterId ? { afterId: parameters.afterId } : {}),
		...(customerId ? { customerId } : {}),
		limit: parameters.limit + 1,
		...(subscriptionId ? { subscriptionId } : {}),
	});
	return context.json(
		stripeList(
			invoices
				.slice(0, parameters.limit)
				.map((invoice) =>
					stripeInvoice(invoice, runtime.state.services.catalog.requirePrice(invoice.priceId)),
				),
			"/v1/invoices",
			invoices.length > parameters.limit,
		),
	);
}

async function retrieveInvoice(context: StripeContext): Promise<Response> {
	await readStripeRequest(context);
	const runtime = context.get("lh");
	const invoice = runtime.state.services.billing.requireInvoice(pathId(context));
	return context.json(
		stripeInvoice(invoice, runtime.state.services.catalog.requirePrice(invoice.priceId)),
	);
}

function stripeMethod(handler: StripeHandler): StripeHandler {
	return async (context) => {
		try {
			return await handler(context);
		} catch (cause) {
			if (!(cause instanceof StripeError)) throw cause;
			return context.json(
				{
					error: {
						code: cause.code,
						message: cause.message,
						...(cause.parameter ? { param: cause.parameter } : {}),
						type: "invalid_request_error",
					},
				},
				stripeHttpStatus(cause),
			);
		}
	};
}

function pathId(context: StripeContext): string {
	const id = context.req.param("id");
	if (!id) throw new StripeError("invalid_argument", "Stripe resource ID is required.", "id");
	return id;
}

function stripeHttpStatus(error: StripeError): 400 | 401 | 404 | 409 {
	if (error.code === "invalid_api_key") return 401;
	if (error.code.endsWith("_missing")) return 404;
	if (error.code === "advance_conflict" || error.code === "subscription_canceled") return 409;
	return 400;
}
