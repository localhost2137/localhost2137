import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BILLING_PERIOD_MS } from "../src/domain/billing-service.js";
import { createStripeServices } from "../src/domain/stripe-services.js";
import { StripeDatabase } from "../src/persistence/database.js";
import { migrateDatabase } from "../src/persistence/migrations.js";
import { createStripePlugin, type StripePluginFactory } from "../src/plugin.js";
import { StripeWebhookDispatcher } from "../src/webhooks/webhook-dispatcher.js";

const ownedRuntimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];
const ownedServers: Array<ReturnType<typeof createServer>> = [];
const roots: string[] = [];

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
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Stripe clock and crash recovery", () => {
	it("replays the original committed advance without duplicate renewals or webhooks", async () => {
		const deliveries: ReceivedRequest[] = [];
		const receiver = await startReceiver(async (request, response) => {
			deliveries.push(await readRequest(request));
			response.writeHead(204).end();
		});
		const advances: Array<Readonly<{ advanceId: string; from: number; to: number }>> = [];
		let interrupt = true;
		const plugin = createStripePlugin({
			afterTimeReconciled(_context, advance) {
				advances.push({
					advanceId: advance.advanceId,
					from: advance.from.getTime(),
					to: advance.to.getTime(),
				});
				if (!interrupt) return;
				interrupt = false;
				throw new Error("injected crash after Stripe renewal commit");
			},
		});
		const runtime = await startRuntime(plugin, {
			clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
			webhookUrl: receiver.url,
		});
		const instance = await runtime.createInstance();
		try {
			const subscription = await createBillingWorld(instance.stripe);
			await instance.idle();
			expect(deliveries.map(eventId)).toEqual(["evt_000001"]);

			await expect(instance.clock.advance("30d")).rejects.toMatchObject({
				code: "INSTANCE_MUTATION_COMMITTED",
				details: { reconciliationPending: true },
			});
			expect(await instance.stripe.listInvoices({ subscriptionId: subscription.id })).toHaveLength(
				2,
			);
			expect(await instance.stripe.listEvents({})).toHaveLength(2);
			expect(deliveries.map(eventId)).toEqual(["evt_000001"]);

			await expect(instance.clock.advance("30d")).resolves.toMatchObject({
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-31T00:00:00.000Z",
			});
			expect(advances).toHaveLength(2);
			expect(advances[1]).toEqual(advances[0]);
			expect(await instance.stripe.listInvoices({ subscriptionId: subscription.id })).toHaveLength(
				2,
			);
			expect(await instance.stripe.listEvents({})).toHaveLength(2);
			expect(deliveries.map(eventId)).toEqual(["evt_000001", "evt_000002"]);

			await instance.clock.advance("90d");
			expect(await instance.stripe.listInvoices({ subscriptionId: subscription.id })).toHaveLength(
				5,
			);
			expect(await instance.stripe.listEvents({})).toHaveLength(5);
			expect(deliveries.map(eventId)).toEqual([
				"evt_000001",
				"evt_000002",
				"evt_000003",
				"evt_000004",
				"evt_000005",
			]);
		} finally {
			await instance.destroy();
		}
	});

	it("replays a remotely observed but locally incomplete webhook byte-for-byte", async () => {
		const root = await mkdtemp(join(tmpdir(), "localhost2137-stripe-replay-"));
		roots.push(root);
		const database = new StripeDatabase(join(root, "stripe.sqlite"));
		try {
			migrateDatabase(database.raw());
			const config = stripeConfig("https://webhook.example.test/stripe");
			const services = createStripeServices(database, config);
			const customer = services.customers.create({ name: "Ada", now: pinnedNow });
			const product = services.catalog.createProduct({ name: "Pro", now: pinnedNow });
			const price = services.catalog.createPrice({
				currency: "usd",
				now: pinnedNow,
				productId: product.id,
				unitAmount: 2_500,
			});
			services.billing.createSubscription({
				customerId: customer.id,
				now: pinnedNow,
				priceId: price.id,
			});
			const advance = {
				advanceId: "advance_interrupted_webhook",
				from: pinnedNow,
				to: new Date(pinnedNow.getTime() + BILLING_PERIOD_MS),
			};
			const [eventId] = services.billing.reconcileTimeAdvance(advance);
			if (!eventId) throw new TypeError("Expected a renewal webhook event.");

			const bodies: string[] = [];
			const remoteReceived = deferred<void>();
			const cancellation = new AbortController();
			const interrupted = new StripeWebhookDispatcher(database, config).reconcile(
				webhookContext(cancellation.signal, async (_input, init) => {
					bodies.push(String(init?.body));
					remoteReceived.resolve(undefined);
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
							once: true,
						});
					});
				}),
				[eventId],
			);
			await remoteReceived.promise;
			cancellation.abort(new Error("injected process interruption"));
			await expect(interrupted).rejects.toThrow(/injected process interruption/);

			await new StripeWebhookDispatcher(database, config).reconcile(
				webhookContext(new AbortController().signal, async (_input, init) => {
					bodies.push(String(init?.body));
					return new Response(null, { status: 204 });
				}),
				services.billing.reconcileTimeAdvance(advance),
			);

			expect(bodies).toHaveLength(2);
			expect(bodies[1]).toBe(bodies[0]);
			expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ id: eventId });
			expect(database.raw().prepare("SELECT count(*) AS count FROM invoices").get()).toEqual({
				count: 2,
			});
			expect(database.raw().prepare("SELECT count(*) AS count FROM events").get()).toEqual({
				count: 2,
			});
			expect(
				database.raw().prepare("SELECT count(*) AS count FROM webhook_deliveries").get(),
			).toEqual({ count: 2 });
			expect(
				database
					.raw()
					.prepare("SELECT count(*) AS count FROM webhook_delivery_attempts WHERE event_id = ?")
					.get(eventId),
			).toEqual({ count: 1 });
			expect(
				database
					.raw()
					.prepare("SELECT status FROM webhook_deliveries WHERE event_id = ?")
					.get(eventId),
			).toEqual({ status: "succeeded" });
			expect(
				database.raw().prepare("SELECT advance_id FROM events WHERE id = ?").get(eventId),
			).toEqual({ advance_id: advance.advanceId });
		} finally {
			database.close();
		}
	});

	it("uses the same exact 30-day renewal boundaries in pinned and real-offset modes", async () => {
		const real = await startRuntime(createStripePlugin(), {
			clock: { mode: "real" },
			webhookUrl: null,
		});
		const realInstance = await real.createInstance();
		const realSubscription = await createBillingWorld(realInstance.stripe);
		const [realInitial] = await realInstance.stripe.listInvoices({
			subscriptionId: realSubscription.id,
		});
		if (!realInitial) throw new TypeError("Expected a real-mode initial invoice.");
		const pinned = await startRuntime(createStripePlugin(), {
			clock: { mode: "pinned", startAt: realInitial.periodStart },
			webhookUrl: null,
		});
		const pinnedInstance = await pinned.createInstance();
		try {
			const pinnedSubscription = await createBillingWorld(pinnedInstance.stripe);
			await Promise.all([pinnedInstance.clock.advance("30d"), realInstance.clock.advance("30d")]);
			const pinnedInvoices = await pinnedInstance.stripe.listInvoices({
				subscriptionId: pinnedSubscription.id,
			});
			const realInvoices = await realInstance.stripe.listInvoices({
				subscriptionId: realSubscription.id,
			});
			expect(pinnedInvoices).toHaveLength(2);
			expect(realInvoices).toHaveLength(2);
			expect(
				pinnedInvoices.map(({ periodEnd, periodStart }) => ({ periodEnd, periodStart })),
			).toEqual(realInvoices.map(({ periodEnd, periodStart }) => ({ periodEnd, periodStart })));
			for (const invoice of [...pinnedInvoices, ...realInvoices]) {
				expect(Date.parse(invoice.periodEnd) - Date.parse(invoice.periodStart)).toBe(
					BILLING_PERIOD_MS,
				);
			}
			expect(await pinnedInstance.stripe.listEvents({})).toEqual(
				await realInstance.stripe.listEvents({}),
			);
		} finally {
			await Promise.all([pinnedInstance.destroy(), realInstance.destroy()]);
		}
	});
});

async function startRuntime(
	plugin: StripePluginFactory,
	input: Readonly<{
		clock: Readonly<{ mode: "pinned"; startAt: string }> | Readonly<{ mode: "real" }>;
		webhookUrl: string | null;
	}>,
) {
	const runtime = await createTestRuntime({
		config: defineConfig({
			clock: input.clock,
			services: {
				stripe: plugin({ config: stripeConfig(input.webhookUrl) }),
			},
		}),
		port: 0,
		storage: "temporary",
	});
	ownedRuntimes.push(runtime);
	return runtime;
}

async function createBillingWorld(
	stripe: Readonly<{
		createCustomer(input: { name: string }): Promise<{ id: string }>;
		createPrice(input: { productId: string; unitAmount: number }): Promise<{ id: string }>;
		createProduct(input: { name: string }): Promise<{ id: string }>;
		createSubscription(input: { customerId: string; priceId: string }): Promise<{ id: string }>;
	}>,
) {
	const customer = await stripe.createCustomer({ name: "Ada" });
	const product = await stripe.createProduct({ name: "Pro" });
	const price = await stripe.createPrice({ productId: product.id, unitAmount: 2_500 });
	return stripe.createSubscription({ customerId: customer.id, priceId: price.id });
}

function stripeConfig(webhookUrl: string | null) {
	return {
		secretKey: "sk_test_local",
		webhookSecret: "whsec_local",
		webhookUrl,
	} as const;
}

function webhookContext(
	signal: AbortSignal,
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	return {
		clock: { now: () => new Date(pinnedNow) },
		fetch,
		log: { info: () => undefined },
		signal,
		tasks: { track: <Value>(_label: string, task: Promise<Value>) => task },
	};
}

interface ReceivedRequest {
	readonly body: string;
}

async function readRequest(request: IncomingMessage): Promise<ReceivedRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Object.freeze({ body: Buffer.concat(chunks).toString("utf8") });
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

function eventId(delivery: ReceivedRequest): unknown {
	return Reflect.get(JSON.parse(delivery.body) as object, "id");
}

function deferred<Value>() {
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}

const pinnedNow = new Date("2026-01-01T00:00:00.000Z");
