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
