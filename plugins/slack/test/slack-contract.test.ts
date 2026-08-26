import { describe, it } from "vitest";
import { createPluginContractCases } from "@localhost2137/plugin-testkit";
import { slackContractFixture } from "./contract/slack-contract-harness.js";

describe("Slack plugin contract", () => {
	for (const contractCase of createPluginContractCases(slackContractFixture)) {
		it(contractCase.name, contractCase.run, 30_000);
	}
});
