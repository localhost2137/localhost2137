import { describe, expect, it } from "vitest";
import { createPluginContractCases, PluginContractAssertionError } from "../src/index.js";

describe("plugin contract testkit API", () => {
	it("publishes a fixed, immutable case inventory", () => {
		const cases: unknown = Reflect.apply(createPluginContractCases, undefined, [fixture()]);
		expect(cases).toHaveLength(18);
		expect(cases).toSatisfy(Object.isFrozen);
		expect(new Set(Reflect.apply(Array.prototype.map, cases, [caseName]))).toHaveLength(18);
	});

	it.each([
		["an empty operation inventory", []],
		["an invalid operation key", [{ cli: "flags", invoke: observe, key: "not-valid" }]],
		[
			"a duplicate operation key",
			[
				{ cli: "flags", invoke: observe, key: "inspect" },
				{ cli: "json", invoke: observe, key: "inspect" },
			],
		],
	])("rejects %s", (_label, operations) => {
		const candidate = fixture();
		candidate.world.operations = operations;
		expect(() => Reflect.apply(createPluginContractCases, undefined, [candidate])).toThrow(
			TypeError,
		);
	});

	it("provides a stable assertion error with case context", () => {
		const failure = new PluginContractAssertionError("state isolation", "values differed");
		expect(failure).toMatchObject({
			caseName: "state isolation",
			message: "state isolation: values differed",
			name: "PluginContractAssertionError",
		});
	});
});

function fixture() {
	const invalid = { create: () => ({}), expectedPath: "$.services.fixture" };
	return {
		authoring: { sideEffects: observe },
		durability: {
			futureVersion: observe,
			restartPersistence: observe,
			stateUpgrade: observe,
		},
		invalid: { config: invalid, environmentCollision: invalid, seed: invalid },
		lifecycle: {
			createFailureRecovery: observe,
			ordering: observe,
			updateFailureRecovery: observe,
		},
		probes: {
			connection: { environmentName: "FIXTURE_URL", readUrl: () => "http://localhost" },
			honoContext: observe,
			isolation: {
				expectedFresh: 0,
				expectedMutated: 1,
				mutate: async () => undefined,
				read: async () => 0,
			},
			outputValidation: observe,
			reset: {
				expectedEmpty: 0,
				expectedSeeded: 1,
				mutate: async () => undefined,
				read: async () => 0,
			},
			storageEscape: observe,
			trackedFetchAndIdle: observe,
		},
		world: {
			createConfig: () => ({ services: {} }),
			operations: [{ cli: "flags", invoke: observe, key: "inspect" }],
			serviceKey: "fixture",
		},
	};
}

function caseName(value: unknown): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, "name") : undefined;
}

function observe() {
	return { actual: true, expected: true };
}
