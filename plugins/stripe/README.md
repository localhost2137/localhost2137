# `@localhost2137/stripe`

A deterministic local Stripe account for recurring-billing development. It provides official-SDK
compatible HTTP routes, typed control operations, SQLite persistence, signed webhooks, and durable
virtual-time renewals without a Stripe account or real credentials.

## Configure

```ts
import { stripe } from "@localhost2137/stripe";
import { defineConfig } from "localhost2137";

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
	services: {
		stripe: stripe({
			config: {
				secretKey: "sk_test_local",
				webhookSecret: "whsec_local",
				webhookUrl: "http://127.0.0.1:3000/stripe/webhooks",
			},
			seed: {
				products: [{ id: "prod_pro", name: "Pro" }],
				prices: [{ product: "prod_pro", unitAmount: 2500 }],
			},
		}),
	},
});
```

`webhookUrl` defaults to `null`. Connection metadata exposes `apiUrl`, `secretKey`, and
`webhookSecret`; its environment projection is `STRIPE_API_URL`, `STRIPE_SECRET_KEY`, and
`STRIPE_WEBHOOK_SECRET`.

## Official Stripe SDK

Stripe's API client fixes requests to `api.stripe.com`, while a localhost2137 service URL also
contains the instance and service path. Use the supplied fetch adapter to preserve normal SDK calls:

```ts
import { createStripeSdkFetch } from "@localhost2137/stripe";
import Stripe from "stripe";

const client = new Stripe(instance.stripe.connection.secretKey, {
	httpClient: Stripe.createFetchHttpClient(
		createStripeSdkFetch(instance.stripe.connection.apiUrl),
	),
	maxNetworkRetries: 0,
});

const customer = await client.customers.create({ name: "Ada" });
```

The executable [`examples/stripe-sdk`](../../examples/stripe-sdk) package creates a customer and
subscription, advances virtual time by 30 days, and lists both invoices through the official SDK.

## Supported HTTP surface

Requests use Bearer authentication. POST bodies use Stripe's
`application/x-www-form-urlencoded` encoding, and list endpoints support deterministic opaque
pagination.

| Resource | Supported methods |
| --- | --- |
| customers | create, retrieve, list |
| products | retrieve, list |
| prices | retrieve, list |
| subscriptions | create, retrieve, cancel |
| invoices | retrieve, list |

Products and prices are created through typed control operations in this compatibility slice.
Unsupported Stripe endpoints deliberately return the runtime's normal not-found response instead
of pretending to implement broader payment behavior.

## Billing and webhook semantics

Every subscription uses an exact 30-day billing period. A positive `instance.clock.advance(...)`
creates every crossed invoice in stable order; replaying the same durable advance ID and window is
idempotent. Canceled subscriptions do not renew.

Invoice events and webhook outbox rows commit in the same SQLite transaction. Webhook attempts send
one stable compact JSON body signed with the configured secret. If a process stops after the remote
receiver observes a request but before local completion, restart may deliver the same event ID and
byte-identical body again (at-least-once delivery). `instance.idle()` drains tracked initial webhook
work; time-advance delivery completes as part of durable reconciliation.

## Control operations

`createCustomer`, `createProduct`, `createPrice`, `createSubscription`, `listInvoices`, `listEvents`,
and `setNextPaymentOutcome` provide deterministic setup and inspection without coupling domain code
to the HTTP adapter. Public routes and control operations share the same domain services and
repositories.

Run the plugin contract and official SDK example with:

```sh
pnpm exec vitest run plugins/stripe/test
pnpm --filter @localhost2137/example-stripe-sdk test
```
