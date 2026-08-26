import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BILLING_PERIOD_MS } from "../src/domain/billing-service.js";
import { createStripeServices, seedStripeServices } from "../src/domain/stripe-services.js";
import { StripeDatabase } from "../src/persistence/database.js";
import {
	assertCurrentDatabaseVersion,
	CURRENT_DATABASE_VERSION,
	migrateDatabase,
} from "../src/persistence/migrations.js";

const roots: string[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Stripe persistence and billing", () => {
	it("migrates an empty database and rejects future schemas", async () => {
		const database = await fixtureDatabase();
		try {
			migrateDatabase(database.raw());
			assertCurrentDatabaseVersion(database.raw());
			expect(database.raw().pragma("user_version", { simple: true })).toBe(
				CURRENT_DATABASE_VERSION,
			);
			database.raw().pragma(`user_version = ${CURRENT_DATABASE_VERSION + 1}`);
			expect(() => migrateDatabase(database.raw())).toThrow(/newer than supported schema 3/);
		} finally {
			database.close();
		}
	});

	it("persists seeded catalog records and reconciles deterministic explicit IDs", async () => {
		const { database, path } = await billingFixture();
		try {
			const services = createStripeServices(database, config);
			seedStripeServices(
				services,
				{
					customers: [{ id: "cus_000007", name: "Seeded" }],
					prices: [{ currency: "usd", product: "prod_000004", unitAmount: 2_500 }],
					products: [{ id: "prod_000004", name: "Pro" }],
				},
				now,
			);
			expect(services.customers.create({ name: "Next", now }).id).toBe("cus_000008");
			expect(services.catalog.createProduct({ name: "Next product", now }).id).toBe("prod_000005");
			database.close();

			const restarted = new StripeDatabase(path);
			try {
				assertCurrentDatabaseVersion(restarted.raw());
				expect(restarted.customers.get("cus_000007")).toMatchObject({ name: "Seeded" });
				expect(restarted.catalog.getPrice("price_000001")).toMatchObject({
					productId: "prod_000004",
					unitAmount: 2_500,
				});
			} finally {
				restarted.close();
			}
		} finally {
			database.close();
		}
	});

	it("orders opaque and width-crossing IDs by durable creation order", async () => {
		const { database, services } = await billingFixture();
		try {
			services.customers.create({ id: "cus_opaque", name: "Opaque", now });
			setSequence(database, "customer", 999_998);
			services.customers.create({ name: "Before width", now });
			services.customers.create({ name: "After width", now });
			expect(services.customers.list({ limit: 10 }).map(({ id }) => id)).toEqual([
				"cus_opaque",
				"cus_999999",
				"cus_1000000",
			]);
			expect(
				services.customers.list({ afterId: "cus_999999", limit: 10 }).map(({ id }) => id),
			).toEqual(["cus_1000000"]);

			services.catalog.createProduct({ id: "prod_opaque", name: "Opaque", now });
			setSequence(database, "product", 999_998);
			services.catalog.createProduct({ name: "Before width", now });
			services.catalog.createProduct({ name: "After width", now });
			expect(services.catalog.listProducts({ limit: 10 }).map(({ id }) => id)).toEqual([
				"prod_opaque",
				"prod_999999",
				"prod_1000000",
			]);

			services.catalog.createPrice({
				currency: "usd",
				id: "price_opaque",
				now,
				productId: "prod_opaque",
				unitAmount: 1,
			});
			setSequence(database, "price", 999_998);
			for (const unitAmount of [2, 3]) {
				services.catalog.createPrice({
					currency: "usd",
					now,
					productId: "prod_opaque",
					unitAmount,
				});
			}
			expect(services.catalog.listPrices({ limit: 10 }).map(({ id }) => id)).toEqual([
				"price_opaque",
				"price_999999",
				"price_1000000",
			]);

			setSequence(database, "invoice", 999_998);
			setSequence(database, "event", 999_998);
			const subscription = services.billing.createSubscription({
				customerId: "cus_opaque",
				now,
				priceId: "price_opaque",
			}).subscription;
			services.billing.reconcileTimeAdvance(
				timeAdvance("ordered_advance", now, new Date(now.getTime() + BILLING_PERIOD_MS)),
			);
			expect(
				services.billing.listInvoices({ subscriptionId: subscription.id }).map(({ id }) => id),
			).toEqual(["in_999999", "in_1000000"]);
			expect(services.billing.listEvents().map(({ id }) => id)).toEqual([
				"evt_999999",
				"evt_1000000",
			]);
		} finally {
			database.close();
		}
	});

	it("backfills durable creation order from a real version-2 database", async () => {
		const { database, path, services } = await billingFixture();
		try {
			services.customers.create({ id: "cus_z", name: "First", now });
			services.customers.create({ id: "cus_a", name: "Second", now });
			database
				.raw()
				.exec(
					await readFile(new URL("./fixtures/schema-v2-downgrade.sql", import.meta.url), "utf8"),
				);
			database.close();

			const upgraded = new StripeDatabase(path);
			try {
				expect(upgraded.raw().pragma("user_version", { simple: true })).toBe(2);
				migrateDatabase(upgraded.raw());
				expect(upgraded.raw().pragma("user_version", { simple: true })).toBe(3);
				const restarted = createStripeServices(upgraded, config);
				expect(restarted.customers.list({ limit: 10 }).map(({ id }) => id)).toEqual([
					"cus_z",
					"cus_a",
				]);
			} finally {
				upgraded.close();
			}
		} finally {
			database.close();
		}
	});

	it("creates an initial invoice and exactly one renewal at each crossed 30-day boundary", async () => {
		const { database, services } = await billingFixture();
		try {
			const created = createWorld(services);
			expect(created.invoice).toMatchObject({
				amountDue: 2_500,
				status: "paid",
			});
			expect(services.billing.listInvoices()).toHaveLength(1);

			const first = timeAdvance("advance_one", now, new Date(now.getTime() + BILLING_PERIOD_MS));
			expect(services.billing.reconcileTimeAdvance(first)).toEqual([]);
			expect(services.billing.listInvoices()).toHaveLength(2);
			expect(services.billing.reconcileTimeAdvance(first)).toEqual([]);
			expect(services.billing.listInvoices()).toHaveLength(2);

			services.billing.reconcileTimeAdvance(
				timeAdvance("advance_two", first.to, new Date(now.getTime() + 3 * BILLING_PERIOD_MS)),
			);
			expect(services.billing.listInvoices()).toHaveLength(4);
			expect(services.billing.requireSubscription(created.subscription.id)).toMatchObject({
				currentPeriodEnd: new Date(now.getTime() + 4 * BILLING_PERIOD_MS),
				currentPeriodStart: new Date(now.getTime() + 3 * BILLING_PERIOD_MS),
			});
		} finally {
			database.close();
		}
	});

	it("rejects billing periods outside the JavaScript Date domain without partial writes", async () => {
		const { database, services } = await billingFixture();
		try {
			const boundary = new Date(8_640_000_000_000_000 - BILLING_PERIOD_MS + 1);
			const customer = services.customers.create({ name: "Ada", now: boundary });
			const product = services.catalog.createProduct({ name: "Pro", now: boundary });
			const price = services.catalog.createPrice({
				currency: "usd",
				now: boundary,
				productId: product.id,
				unitAmount: 2_500,
			});

			expect(() =>
				services.billing.createSubscription({
					customerId: customer.id,
					now: boundary,
					priceId: price.id,
				}),
			).toThrow(/exceeds the JavaScript Date range/);
			expect(database.raw().prepare("SELECT count(*) AS count FROM subscriptions").get()).toEqual({
				count: 0,
			});
			expect(services.billing.listInvoices()).toEqual([]);
			expect(services.billing.listEvents()).toEqual([]);
		} finally {
			database.close();
		}
	});

	it("rejects invalid and non-increasing time advances before persistence", async () => {
		const { database, services } = await billingFixture();
		try {
			expect(() =>
				services.billing.reconcileTimeAdvance(timeAdvance("advance_equal", now, now)),
			).toThrow(/must end after/);
			expect(() =>
				services.billing.reconcileTimeAdvance(
					timeAdvance("advance_invalid", now, new Date(Number.NaN)),
				),
			).toThrow(/must be a valid Date/);
			expect(database.raw().prepare("SELECT count(*) AS count FROM time_advances").get()).toEqual({
				count: 0,
			});
		} finally {
			database.close();
		}
	});

	it("rolls back renewal effects with the advance ledger and replays safely", async () => {
		const { database, services } = await billingFixture();
		try {
			createWorld(services);
			database.raw().exec(`
				CREATE TRIGGER reject_time_advance
				BEFORE INSERT ON time_advances
				BEGIN
					SELECT RAISE(ABORT, 'injected advance ledger failure');
				END;
			`);
			const advance = timeAdvance(
				"advance_retry",
				now,
				new Date(now.getTime() + BILLING_PERIOD_MS),
			);

			expect(() => services.billing.reconcileTimeAdvance(advance)).toThrow(
				/injected advance ledger failure/,
			);
			expect(services.billing.listInvoices()).toHaveLength(1);
			database.raw().exec("DROP TRIGGER reject_time_advance");
			services.billing.reconcileTimeAdvance(advance);
			expect(services.billing.listInvoices()).toHaveLength(2);
			expect(() =>
				services.billing.reconcileTimeAdvance({
					...advance,
					to: new Date(advance.to.getTime() + 1),
				}),
			).toThrow(/different range/);
		} finally {
			database.close();
		}
	});

	it("consumes a forced payment failure once and stops renewals after cancellation", async () => {
		const { database, services } = await billingFixture();
		try {
			const created = createWorld(services);
			services.billing.setNextPaymentOutcome(created.subscription.id, "failed");
			services.billing.reconcileTimeAdvance(
				timeAdvance("advance_failed", now, new Date(now.getTime() + BILLING_PERIOD_MS)),
			);
			expect(services.billing.listInvoices().at(-1)).toMatchObject({ status: "open" });
			expect(services.billing.listEvents().at(-1)).toMatchObject({
				type: "invoice.payment_failed",
			});

			services.billing.cancelSubscription(
				created.subscription.id,
				new Date(now.getTime() + BILLING_PERIOD_MS + 1),
			);
			services.billing.reconcileTimeAdvance(
				timeAdvance(
					"advance_canceled",
					new Date(now.getTime() + BILLING_PERIOD_MS),
					new Date(now.getTime() + 3 * BILLING_PERIOD_MS),
				),
			);
			expect(services.billing.listInvoices()).toHaveLength(2);
		} finally {
			database.close();
		}
	});
});

async function billingFixture() {
	const database = await fixtureDatabase();
	migrateDatabase(database.raw());
	return {
		database,
		path: database.raw().name,
		services: createStripeServices(database, config),
	};
}

function createWorld(services: ReturnType<typeof createStripeServices>) {
	const customer = services.customers.create({ name: "Ada", now });
	const product = services.catalog.createProduct({ name: "Pro", now });
	const price = services.catalog.createPrice({
		currency: "usd",
		now,
		productId: product.id,
		unitAmount: 2_500,
	});
	return services.billing.createSubscription({
		customerId: customer.id,
		now,
		priceId: price.id,
	});
}

async function fixtureDatabase(): Promise<StripeDatabase> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-stripe-"));
	roots.push(root);
	return new StripeDatabase(join(root, "stripe.sqlite"));
}

function timeAdvance(advanceId: string, from: Date, to: Date) {
	return { advanceId, from, to };
}

function setSequence(database: StripeDatabase, kind: string, value: number): void {
	database
		.raw()
		.prepare(
			`INSERT INTO counters(kind, value) VALUES (?, ?)
			 ON CONFLICT(kind) DO UPDATE SET value = excluded.value`,
		)
		.run(kind, value);
}

const config = Object.freeze({
	secretKey: "sk_test_local",
	webhookSecret: "whsec_local",
	webhookUrl: null,
});
