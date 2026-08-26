import { appendFileSync, readFileSync } from "node:fs";
import {
	CONTRACT_FAIL_TIME_ADVANCE_ENV,
	CONTRACT_TIME_ADVANCE_EVENT_PREFIX,
} from "@localhost2137/plugin-testkit";
import { defineConfig } from "localhost2137";
import { createStripePlugin } from "../../src/plugin.js";

const root = process.env.LOCALHOST2137_CONTRACT_STORAGE;
const eventsPath = process.env.LOCALHOST2137_CONTRACT_EVENTS;
const webhookUrl = process.env.LOCALHOST2137_CONTRACT_DELIVERY_URL;
const stateVersion = Number(process.env.LOCALHOST2137_CONTRACT_VERSION);
if (
	!root ||
	!eventsPath ||
	!webhookUrl ||
	!Number.isSafeInteger(stateVersion) ||
	stateVersion < 1
) {
	throw new TypeError("Stripe durability fixture environment is incomplete.");
}

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-02T03:04:05.000Z" },
	services: {
		stripe: createStripePlugin({
			afterTimeReconciled(_context, advance) {
				appendFileSync(
					eventsPath,
					`${CONTRACT_TIME_ADVANCE_EVENT_PREFIX}${JSON.stringify({
						advanceId: advance.advanceId,
						from: advance.from.toISOString(),
						to: advance.to.toISOString(),
					})}\n`,
					"utf8",
				);
				if (process.env[CONTRACT_FAIL_TIME_ADVANCE_ENV] === "1") {
					throw new Error("injected crash after Stripe renewal commit");
				}
			},
			...(stateVersion === 2
				? {
						beforeStop(context) {
							context.state.database
								.raw()
								.exec(
									readFileSync(
										new URL("../fixtures/schema-v2-downgrade.sql", import.meta.url),
										"utf8",
									),
								);
						},
					}
				: {}),
			recordLifecycle(event) {
				if (!event.startsWith("update:")) return;
				appendFileSync(eventsPath, `${event}\n`, "utf8");
				if (process.env.LOCALHOST2137_CONTRACT_FAIL_UPDATE === "1") {
					throw new Error("injected Stripe update failure");
				}
			},
			stateVersion,
		})({
			config: stripeConfig(webhookUrl),
			seed: { customers: [{ name: "Grace" }] },
		}),
	},
	storage: { dir: root },
});

function stripeConfig(webhookUrl: string) {
	return {
		secretKey: "sk_test_local_contract",
		webhookSecret: "whsec_local_contract",
		webhookUrl,
	} as const;
}
