import { createPluginContractCases } from "@localhost2137/plugin-testkit";
import { describe, it } from "vitest";
import { stripeContractFixture } from "./contract/stripe-contract-harness.js";

describe("Stripe plugin contract", () => {
	for (const contractCase of createPluginContractCases(stripeContractFixture)) {
		it(contractCase.name, contractCase.run, 30_000);
	}
});
