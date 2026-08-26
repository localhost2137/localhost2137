import { stripe } from "@localhost2137/stripe";
import { defineConfig } from "localhost2137";

export const stripeAuthoringConfig = defineConfig({
	services: {
		stripe: stripe({
			config: {
				secretKey: "sk_test_local_authoring",
				webhookSecret: "whsec_local_authoring",
				webhookUrl: null,
			},
		}),
	},
});
