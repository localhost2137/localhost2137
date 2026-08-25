/**
 * Comprehensive localhost2137 config — every knob we think v1 needs.
 *
 * Decided shape: keyed `services` map + explicit factory envelope
 * `{ config, seed? }`:
 *
 *   key    → THE identity. Derives URL prefix, CLI selector, storage
 *            namespace, and the localhost.<key> lookup. Want a different
 *            URL? Name the key differently — no override layer.
 *            Mount the same plugin twice with two keys = two workspaces.
 *   config → plugin behavior; validated against plugin's configSchema.
 *   seed   → initial world data; validated against plugin's seedSchema.
 *            NOT applied automatically — runs on `localhost seed`, before
 *            the top-level scenario seed below.
 *
 * Everything outside `services` is optional; values below are defaults or
 * plausible examples. Ordinary TypeScript is the escape hatch — e.g.
 * port: Number(process.env.LH_PORT ?? 2137). Config objects may also live in
 * imported files; same semantics.
 */
import { defineConfig } from "localhost2137";
import { slack } from "@localhost2137/slack";
import { stripe } from "@localhost2137/stripe";
import { github } from "@localhost2137/github";

export default defineConfig({
	// ── Runtime ─────────────────────────────────────────────────────────
	host: "127.0.0.1", // loopback only; the control plane is privileged
	port: 2137,

	// Where instance state lives. Project-local by default so a world is
	// disposable together with the repo (.localhost2137/ gitignored).
	// Layout is runtime-derived, never configured per-service:
	//   .localhost2137/instances/dev/{slack,stripe,…}
	storage: {
		dir: ".localhost2137",
	},

	// ── Virtual time ────────────────────────────────────────────────────
	clock: {
		mode: "real", // follow the wall clock…
		// mode: "pinned",           // …or freeze at startAt until advanced
		startAt: "2026-01-01T00:00:00.000Z", // deterministic tests want "pinned"
	},

	// ── Services ────────────────────────────────────────────────────────
	services: {
		slack: slack({
			config: {
				workspaceName: "Acme Dev",
				botToken: "xoxb-local-acme", // fake on purpose — see connection metadata
				signingSecret: "local-signing-secret",
				eventsUrl: "http://127.0.0.1:3000/slack/events", // emulator POSTs Events payloads here
			},

			// Baseline world applied only by `localhost seed` or a reset/create
			// with `--seed`, before the top-level scenario below.
			seed: {
				users: [
					{ id: "U_ALICE", name: "Alice", admin: true },
					{ id: "U_BOT", name: "acme-bot" },
				],
				channels: [{ id: "C_GENERAL", name: "general", members: ["U_ALICE", "U_BOT"] }],
			},
		}),

		// The key is the URL, the CLI selector, and localhost.<key>. If your
		// Stripe SDK needs a "/stripe"-shaped base URL, the key IS "stripe".
		stripe: stripe({
			config: {
				apiKey: "sk_test_local_acme",
				webhookSecret: "whsec_local_acme",
				webhookUrl: "http://127.0.0.1:3000/stripe/webhook",
			},
			seed: {
				customers: [{ id: "cus_alice", email: "alice@acme.dev" }],
				prices: [
					{ id: "price_pro_monthly", currency: "usd", unitAmount: 2_000, interval: "month" },
				],
			},
		}),

		github: github({
			config: {
				token: "ghp_local_acme",
			},
		}),
	},

	// ── Scenarios (top-level imperative seed) ───────────────────────────
	// Runs only when seeding is requested (`localhost seed` /
	// localhost.seed()), AFTER all plugins interpreted their declarative
	// seed — so the baseline world exists and can be referenced by stable
	// ids (U_ALICE, cus_alice, price_pro_monthly). This is where cross-
	// service stories go: ordinary TypeScript composing operations.
	async seed(localhost) {
		await localhost.stripe.createSubscription({
			customerId: "cus_alice",
			priceId: "price_pro_monthly",
		});
		await localhost.slack.sendMessage({
			channel: "C_GENERAL",
			from: "U_BOT",
			text: "Alice's Pro subscription is active 🎉",
		});
	},
});

/*
 * Lifecycle for a fresh instance:  create (each plugin) → start
 * Seeding is explicit:             localhost seed → plugin seeds → top-level scenario
 * Plugin state upgrades:          update({ from, to }) before start
 */
