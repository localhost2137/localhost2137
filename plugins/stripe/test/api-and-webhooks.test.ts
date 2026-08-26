import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { defineConfig } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { stripe } from "../src/index.js";
import { createStripeSdkFetch } from "../src/sdk-fetch.js";
import { verifyStripeWebhookSignature } from "../src/webhooks/signature.js";

const ownedRuntimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];
const ownedServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
	await Promise.all(ownedRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		ownedServers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((cause) => (cause ? reject(cause) : resolve()));
				}),
		),
	);
});

describe("Stripe HTTP and webhook compatibility", () => {
	it("serves the supported form-authenticated Stripe API with stable list and error envelopes", async () => {
		const runtime = await startRuntime(null);
		const instance = await runtime.createInstance({ seed: true });
		try {
			const connection = instance.stripe.connection;
			const unauthorized = await fetch(`${connection.apiUrl}/v1/customers`);
			expect(unauthorized.status).toBe(401);
			expect(await unauthorized.json()).toEqual({
				error: {
					code: "invalid_api_key",
					message: "Invalid API Key provided.",
					type: "invalid_request_error",
				},
			});

			const customer = await stripePost(connection, "/v1/customers", {
				email: "ada@example.test",
				name: "Ada",
			});
			expect(customer).toMatchObject({
				email: "ada@example.test",
				id: "cus_000001",
				livemode: false,
				object: "customer",
			});
			const customers = await stripeGet(connection, "/v1/customers?limit=1");
			expect(customers).toMatchObject({
				data: [{ id: "cus_000001", name: "Ada" }],
				has_more: false,
				object: "list",
				url: "/v1/customers",
			});
			for (const cursor of ["cus_unknown", "prod_000001"]) {
				const response = await fetch(`${connection.apiUrl}/v1/customers?starting_after=${cursor}`, {
					headers: { authorization: `Bearer ${connection.secretKey}` },
				});
				expect(response.status, cursor).toBe(404);
				expect(await response.json(), cursor).toMatchObject({
					error: { code: "customer_missing", type: "invalid_request_error" },
				});
			}

			const subscription = await stripePost(connection, "/v1/subscriptions", {
				customer: "cus_000001",
				"items[0][price]": "price_000001",
			});
			expect(subscription).toMatchObject({
				current_period_end: 1_769_817_600,
				current_period_start: 1_767_225_600,
				customer: "cus_000001",
				id: "sub_000001",
				items: { data: [{ price: { id: "price_000001" } }] },
				latest_invoice: "in_000001",
				object: "subscription",
			});
			const invoices = await stripeGet(connection, "/v1/invoices?subscription=sub_000001");
			expect(invoices).toMatchObject({
				data: [
					{
						amount_due: 2_500,
						id: "in_000001",
						object: "invoice",
						paid: true,
						status: "paid",
					},
				],
			});
			const afterInvoice = await stripeGet(
				connection,
				"/v1/invoices?limit=1&starting_after=in_000001",
			);
			expect(afterInvoice).toMatchObject({ data: [], has_more: false });
		} finally {
			await instance.destroy();
		}
	});

	it("rewrites fixed-origin SDK requests without depending on the Stripe SDK", async () => {
		let received: Request | URL | string | undefined;
		const rewritten = createStripeSdkFetch("http://127.0.0.1:2137/dev/stripe/", async (input) => {
			received = input;
			return new Response(null, { status: 204 });
		});
		await rewritten(
			new Request("https://api.stripe.com/v1/customers?limit=2", {
				headers: { authorization: "Bearer sk_test_local" },
			}),
		);
		const request = received instanceof Request ? received : new Request(String(received));
		expect(request.url).toBe("http://127.0.0.1:2137/dev/stripe/v1/customers?limit=2");
		expect(request.headers.get("authorization")).toBe("Bearer sk_test_local");
	});

	it("delivers one stable signed invoice event and drains it through instance idle", async () => {
		const received = deferred<ReceivedRequest>();
		const receiver = await startReceiver(async (request, response) => {
			received.resolve(await readRequest(request));
			response.writeHead(204).end();
		});
		const runtime = await startRuntime(receiver.url);
		const instance = await runtime.createInstance({ seed: true });
		try {
			const customer = await instance.stripe.createCustomer({ name: "Ada" });
			const subscription = await instance.stripe.createSubscription({
				customerId: customer.id,
				priceId: "price_000001",
			});
			await instance.idle();
			const delivery = await received.promise;
			const signature = requiredHeader(delivery.headers, "stripe-signature");
			expect(
				verifyStripeWebhookSignature({
					body: delivery.body,
					secret: instance.stripe.connection.webhookSecret,
					signature,
				}),
			).toBe(true);
			expect(JSON.parse(delivery.body)).toMatchObject({
				data: {
					object: {
						id: subscription.latestInvoiceId,
						object: "invoice",
						subscription: subscription.id,
					},
				},
				id: "evt_000001",
				livemode: false,
				object: "event",
				type: "invoice.paid",
			});
		} finally {
			await instance.destroy();
		}
	});
});

async function startRuntime(webhookUrl: string | null) {
	const runtime = await createTestRuntime({
		config: defineConfig({
			clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
			services: {
				stripe: stripe({
					config: {
						secretKey: "sk_test_local",
						webhookSecret: "whsec_local",
						webhookUrl,
					},
					seed: {
						prices: [{ currency: "usd", product: "prod_000001", unitAmount: 2_500 }],
						products: [{ name: "Pro" }],
					},
				}),
			},
		}),
		port: 0,
		storage: "temporary",
	});
	ownedRuntimes.push(runtime);
	return runtime;
}

async function stripePost(
	connection: Readonly<{ apiUrl: string; secretKey: string }>,
	path: string,
	values: Readonly<Record<string, string>>,
): Promise<unknown> {
	const response = await fetch(`${connection.apiUrl}${path}`, {
		body: new URLSearchParams(values),
		headers: {
			authorization: `Bearer ${connection.secretKey}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function stripeGet(
	connection: Readonly<{ apiUrl: string; secretKey: string }>,
	path: string,
): Promise<unknown> {
	const response = await fetch(`${connection.apiUrl}${path}`, {
		headers: { authorization: `Bearer ${connection.secretKey}` },
	});
	expect(response.status).toBe(200);
	return response.json();
}

interface ReceivedRequest {
	readonly body: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

async function readRequest(request: IncomingMessage): Promise<ReceivedRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Object.freeze({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
}

async function startReceiver(
	handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<Readonly<{ url: string }>> {
	const server = createServer((request, response) => {
		void handler(request, response).catch(() => response.destroy());
	});
	ownedServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address() as AddressInfo;
	return Object.freeze({ url: `http://127.0.0.1:${address.port}/stripe/webhooks` });
}

function requiredHeader(
	headers: Readonly<Record<string, string | string[] | undefined>>,
	name: string,
): string {
	const value = headers[name];
	if (typeof value !== "string") throw new TypeError(`Missing ${name} header.`);
	return value;
}

function deferred<Value>() {
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}
