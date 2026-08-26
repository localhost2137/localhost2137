import { describe, it } from "vitest";
import { createPluginContractCases } from "../src/index.js";
import { minimalContractFixture } from "./fixtures/minimal-contract-fixture.js";

describe("minimal fixture plugin contract", () => {
	for (const contractCase of createPluginContractCases(minimalContractFixture)) {
		it(contractCase.name, contractCase.run, 30_000);
	}
});
