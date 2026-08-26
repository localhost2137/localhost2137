import { defineConfig } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { StripeSeed } from "../src/config.js";
import { stripe } from "../src/index.js";

const ownedRuntimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];

afterEach(async () => {
	await Promise.all(ownedRuntimes.splice(0).map((runtime) => runtime.close()));
});

describe("Stripe runtime integration", () => {
	it("projects frozen connection metadata and applies an atomic deterministic seed", async () => {
		const runtime = await startRuntime({
			customers: [{ id: "cus_000007", name: "Seeded customer" }],
			prices: [{ currency: "usd", id: "price_000004", product: "prod_000003", unitAmount: 2_500 }],
			products: [{ id: "prod_000003", name: "Pro" }],
		});
		const instance = await runtime.createInstance({ seed: true });
		try {
			expect(instance.stripe.connection).toMatchObject({
				secretKey: "sk_test_local",
				webhookSecret: "whsec_local",
			});
			expect(instance.stripe.connection.apiUrl).toMatch(/\/stripe$/);
			expect(Object.isFrozen(instance.stripe.connection)).toBe(true);

			expect(await instance.stripe.createCustomer({ name: "Next customer" })).toEqual({
				email: null,
				id: "cus_000008",
				name: "Next customer",
			});
			expect(await instance.stripe.createProduct({ name: "Next product" })).toMatchObject({
				id: "prod_000004",
			});
			const subscription = await instance.stripe.createSubscription({
				customerId: "cus_000007",
				priceId: "price_000004",
			});
			expect(subscription).toMatchObject({
				currentPeriodEnd: "2026-01-31T00:00:00.000Z",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				id: "sub_000001",
				latestInvoiceId: "in_000001",
				status: "active",
			});
			expect(await instance.stripe.listInvoices({ subscriptionId: subscription.id })).toEqual([
				expect.objectContaining({ amountDue: 2_500, id: "in_000001", status: "paid" }),
			]);
		} finally {
			await instance.destroy();
		}
	});

	it("uses operations and virtual time against one durable billing world", async () => {
		const runtime = await startRuntime();
		const instance = await runtime.createInstance();
		try {
			const customer = await instance.stripe.createCustomer({
				email: "ada@example.test",
				name: "Ada",
			});
			const product = await instance.stripe.createProduct({ name: "Pro" });
			const price = await instance.stripe.createPrice({
				productId: product.id,
				unitAmount: 2_500,
			});
			const subscription = await instance.stripe.createSubscription({
				customerId: customer.id,
				priceId: price.id,
			});
			await instance.stripe.setNextPaymentOutcome({
				outcome: "failed",
				subscriptionId: subscription.id,
			});

			await expect(instance.clock.advance("30d")).resolves.toMatchObject({
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-31T00:00:00.000Z",
			});
			expect(await instance.stripe.listInvoices({ subscriptionId: subscription.id })).toEqual([
				expect.objectContaining({ id: "in_000001", status: "paid" }),
				expect.objectContaining({ id: "in_000002", status: "open" }),
			]);
			expect(await instance.stripe.listEvents({ type: "invoice.payment_failed" })).toEqual([
				expect.objectContaining({ id: "evt_000002", invoiceId: "in_000002" }),
			]);
		} finally {
			await instance.destroy();
		}
	});

	it("surfaces domain failures through stable Stripe operation codes", async () => {
		const runtime = await startRuntime();
		const instance = await runtime.createInstance();
		try {
			await expect(
				instance.stripe.createPrice({ productId: "prod_missing", unitAmount: 2_500 }),
			).rejects.toMatchObject({ code: "STRIPE_PRODUCT_MISSING", status: 404 });
		} finally {
			await instance.destroy();
		}
	});
});

async function startRuntime(seed?: StripeSeed) {
	const runtime = await createTestRuntime({
		config: defineConfig({
			clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
			services: {
				stripe: stripe({
					config: {
						secretKey: "sk_test_local",
						webhookSecret: "whsec_local",
						webhookUrl: null,
					},
					...(seed ? { seed } : {}),
				}),
			},
		}),
		port: 0,
		storage: "temporary",
	});
	ownedRuntimes.push(runtime);
	return runtime;
}
