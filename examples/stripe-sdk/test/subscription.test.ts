import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import config from "../localhost.config.js";
import { createLocalStripe } from "../src/local-stripe.js";

const runtimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("official Stripe SDK", () => {
	it("creates and renews a subscription through normal SDK calls", async () => {
		const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
		runtimes.push(runtime);
		const instance = await runtime.createInstance();
		try {
			const product = await instance.stripe.createProduct({ name: "Pro" });
			const price = await instance.stripe.createPrice({
				productId: product.id,
				unitAmount: 2_500,
			});
			const client = createLocalStripe(instance.stripe.connection);

			const customer = await client.customers.create({
				email: "ada@example.test",
				name: "Ada",
			});
			await expect(client.customers.retrieve("cus_missing")).rejects.toMatchObject({
				code: "customer_missing",
				statusCode: 404,
				type: "StripeInvalidRequestError",
			});
			const subscription = await client.subscriptions.create({
				customer: customer.id,
				items: [{ price: price.id }],
			});
			expect(subscription).toMatchObject({
				customer: customer.id,
				id: "sub_000001",
				latest_invoice: "in_000001",
				status: "active",
			});

			await instance.clock.advance("30d");
			const invoices = await client.invoices.list({
				limit: 10,
				subscription: subscription.id,
			});
			expect(invoices.data.map(({ id }) => id)).toEqual(["in_000001", "in_000002"]);
			expect(invoices.data[1]).toMatchObject({
				amount_paid: 2_500,
				customer: customer.id,
				paid: true,
				subscription: subscription.id,
			});
		} finally {
			await instance.destroy();
		}
	});
});
