# `@localhost2137/stripe`

A stateful local Stripe account plugin for localhost2137. The current compatibility slice covers
customers, a seeded or control-created catalog, fixed recurring subscriptions, invoices, and signed
invoice webhooks.

## Install

Merge this native dependency permission into the project workspace file before installing:

```yaml title="pnpm-workspace.yaml"
allowBuilds:
  better-sqlite3: true
```

```sh
pnpm add -D localhost2137 @localhost2137/stripe hono@^4.13.4 zod@^4.4.3
pnpm add stripe@22.5.0
```

## Mount

```ts title="localhost.config.ts"
import { stripe } from "@localhost2137/stripe";
import { defineConfig } from "localhost2137";

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
	services: {
		stripe: stripe({
			config: {
				secretKey: "sk_test_local_sdk",
				webhookSecret: "whsec_local_sdk",
				webhookUrl: null,
			},
		}),
	},
});
```

## Wire Stripe Node

```ts title="src/local-stripe.ts"
import { createStripeSdkFetch } from "@localhost2137/stripe";
import Stripe from "stripe";

export interface LocalStripeConnection {
	readonly apiUrl: string;
	readonly secretKey: string;
}

/** Builds the official Stripe SDK against one localhost2137 instance-scoped account. */
export function createLocalStripe(connection: LocalStripeConnection): Stripe {
	return new Stripe(connection.secretKey, {
		httpClient: Stripe.createFetchHttpClient(createStripeSdkFetch(connection.apiUrl)),
		maxNetworkRetries: 0,
	});
}
```

The connection also exposes `webhookSecret`; environment names are `STRIPE_API_URL`,
`STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`. Set `webhookUrl` to the application's receiver when
the scenario needs callbacks.

## Supported surface

| HTTP resources | Control operations |
| --- | --- |
| customers: create, retrieve, list | `createCustomer` |
| products: retrieve, list | `createProduct` |
| prices: retrieve, list | `createPrice` |
| subscriptions: create, retrieve, cancel | `createSubscription` |
| invoices: retrieve, list | `listInvoices` |
| | `listEvents` |
| | `setNextPaymentOutcome` |

```sh
pnpm exec localhost describe stripe --json
pnpm exec localhost exec stripe --help
```

The checked Stripe Node 22.5.0 path creates a customer and subscription, advances the instance clock
30 days, and lists both invoices through the official SDK. Products and prices remain read-only over
HTTP. Webhook retries are not scheduled after an ordinary terminal attempt; recovery may redeliver a
pending event after process interruption.

The [full Stripe plugin reference](https://localhost2137.dev/first-party/stripe) contains the complete
SDK test, exact inputs and error shapes, renewal behavior, webhook signature and recovery rules,
persistence, and deliberate differences.
