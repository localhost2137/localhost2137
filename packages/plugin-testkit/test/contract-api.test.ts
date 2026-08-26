import { describe, expect, it } from "vitest";
import { createPluginContractCases, PluginContractAssertionError } from "../src/index.js";
import { createFixtureConfig } from "./fixtures/fixture-plugin.js";
import { minimalContractFixture } from "./fixtures/minimal-contract-fixture.js";

const CASE_NAMES = Object.freeze([
	"authoring has no import or configuration side effects",
	"invalid config reports its schema path",
	"invalid seed reports its schema path",
	"connection environment collisions identify the configuration path",
	"lifecycle follows create/update/start/seed/stop order",
	"create failure is recoverable",
	"update failure is recoverable",
	"operations validate, introspect, and expose unique CLI representations",
	"invalid operation output is rejected",
	"simultaneous instances never share state",
	"public Hono routes receive instance context",
	"plugin storage rejects escape paths",
	"connections and environment values are instance-correct",
	"tracked fetch work is drained by idle",
	"reset is empty and reset with seed applies once",
	"state persists across runtime restart",
	"future stored state versions are rejected",
	"state-version upgrades preserve data",
]);

describe("plugin contract testkit API", () => {
	it("publishes the fixed, immutable case inventory", () => {
		const cases = createPluginContractCases(minimalContractFixture);
		expect(cases).toSatisfy(Object.isFrozen);
		expect(cases.map(({ name }) => name)).toEqual(CASE_NAMES);
	});

	it.each([
		["an empty operation inventory", []],
		["an invalid operation key", [{ cli: "flags", expected: {}, input: {}, key: "not-valid" }]],
		[
			"a duplicate operation key",
			[
				{ cli: "flags", expected: {}, input: {}, key: "read" },
				{ cli: "json", expected: {}, input: {}, key: "read" },
			],
		],
	])("rejects %s", (_label, operations) => {
		const candidate = mutableFixture();
		candidate.operations = operations;
		expect(() => Reflect.apply(createPluginContractCases, undefined, [candidate])).toThrow(
			TypeError,
		);
	});

	it.each([
		[
			"a non-file authoring module",
			(candidate: ReturnType<typeof mutableFixture>) => {
				candidate.authoring = {
					...candidate.authoring,
					module: new URL("https://example.invalid/fixture.js"),
				};
			},
		],
		[
			"an invalid authoring export name",
			(candidate: ReturnType<typeof mutableFixture>) => {
				candidate.authoring = { ...candidate.authoring, exportName: "not-an-export-name" };
			},
		],
		[
			"a non-positive selected state version",
			(candidate: ReturnType<typeof mutableFixture>) => {
				candidate.harness = { ...candidate.harness, stateVersion: 0 };
			},
		],
		[
			"unordered durability versions",
			(candidate: ReturnType<typeof mutableFixture>) => {
				candidate.durability = {
					...candidate.durability,
					versions: { current: 2, future: 1, old: 3 },
				};
			},
		],
	] as const)("rejects %s", (_label, mutate) => {
		const candidate = mutableFixture();
		mutate(candidate);
		expect(() => createPluginContractCases(candidate as never)).toThrow(TypeError);
	});

	it.each([
		[
			"a non-canonical time-advance duration",
			{
				arrange: [],
				deliveries: { afterArrange: 0, afterCommittedAdvance: 0, afterRecovery: 0 },
				duration: "30 days",
				observations: [{ expected: { value: 0 }, read: { input: {}, operation: "read" } }],
			},
		],
		[
			"time advancement without an observation",
			{
				arrange: [],
				deliveries: { afterArrange: 0, afterCommittedAdvance: 0, afterRecovery: 0 },
				duration: "30d",
				observations: [],
			},
		],
		[
			"non-monotonic time-advance delivery counts",
			{
				arrange: [],
				deliveries: { afterArrange: 1, afterCommittedAdvance: 0, afterRecovery: 2 },
				duration: "30d",
				observations: [{ expected: { value: 0 }, read: { input: {}, operation: "read" } }],
			},
		],
	] as const)("rejects %s", (_label, timeAdvance) => {
		const candidate = mutableFixture();
		candidate.durability = { ...candidate.durability, timeAdvance };
		expect(() => createPluginContractCases(candidate as never)).toThrow(TypeError);
	});

	it("provides a stable assertion error with case context", () => {
		const failure = new PluginContractAssertionError("state isolation", "values differed");
		expect(failure).toMatchObject({
			caseName: "state isolation",
			message: "state isolation: values differed",
			name: "PluginContractAssertionError",
		});
	});

	it("bounds noisy authoring children without exposing their output", async () => {
		const secret = "authoring-secret-must-not-escape";
		for (const stream of ["stdout", "stderr"] as const) {
			const candidate = mutableFixture();
			candidate.authoring = {
				exportName: "noisyConfig",
				module: new URL(`./fixtures/authoring-output.config.ts?stream=${stream}`, import.meta.url),
			};
			const startedAt = Date.now();
			let failure: unknown;
			try {
				await caseAt(candidate, 0).run();
			} catch (cause) {
				failure = cause;
			}
			expect(failure).toBeInstanceOf(PluginContractAssertionError);
			expect(String(failure)).toContain(`authoring child ${stream} emitted output`);
			expect(String(failure)).not.toContain(secret);
			expect(Date.now() - startedAt).toBeLessThan(2_500);
		}

		await expect(caseAt(mutableFixture(), 0).run()).resolves.toBeUndefined();
	});

	it("does not accept an error forged by an invalid-config factory", async () => {
		const forged = Object.assign(new Error("forged"), {
			code: "CONFIG_INVALID",
			details: { issues: [{ path: "$.services.fixture" }] },
		});
		const candidate = mutableFixture();
		candidate.harness = {
			...candidate.harness,
			createInvalidConfig: () => {
				throw forged;
			},
		};
		const invalidConfigCase = createPluginContractCases(candidate as never)[1];
		if (!invalidConfigCase) throw new TypeError("Invalid-config case is missing.");
		await expect(invalidConfigCase.run()).rejects.toBe(forged);
	});

	it("preserves undefined rejections after owned runtime cleanup", async () => {
		const candidate = mutableFixture();
		candidate.hono = {
			...candidate.hono,
			normalize: () => {
				throw undefined;
			},
		};
		const honoCase = createPluginContractCases(candidate as never)[10];
		if (!honoCase) throw new TypeError("Semantic HTTP case is missing.");
		let didReject = false;
		try {
			await honoCase.run();
		} catch (cause) {
			didReject = true;
			expect(cause).toBeUndefined();
		}
		expect(didReject).toBe(true);
	});

	it("rejects a fixture that names the wrong selected plugin", async () => {
		const candidate = mutableFixture();
		candidate.harness = { ...candidate.harness, pluginId: "different" };
		await expect(caseAt(candidate, 7).run()).rejects.toThrow(
			"selected plugin id differs from public introspection",
		);
	});

	it("rejects a fixture whose inventory omits a declared contract operation", () => {
		const candidate = mutableFixture();
		candidate.operations = candidate.operations.slice(0, 2);
		expect(() => caseAt(candidate, 7)).toThrow(
			"Contract call references undeclared operation read",
		);
	});

	it("rejects a harness that substitutes the base variant for a requested fault", async () => {
		const candidate = mutableFixture();
		candidate.harness = {
			...candidate.harness,
			createConfig: ({ instrumentation, resources }) =>
				createFixtureConfig(resources.deliveryUrl, { record: instrumentation.record }),
		};
		await expect(caseAt(candidate, 8).run()).rejects.toThrow(
			"selected operation did not reject its invalid output",
		);
	});

	it("bounds a tracked operation that never reaches its configured receiver", async () => {
		const candidate = mutableFixture();
		candidate.harness = {
			...candidate.harness,
			createConfig: ({ instrumentation }) =>
				createFixtureConfig("data:text/plain,not-the-owned-receiver", {
					record: instrumentation.record,
				}),
		};
		const startedAt = Date.now();
		await expect(caseAt(candidate, 13).run()).rejects.toThrow(
			"operation did not reach the owned delivery receiver",
		);
		expect(Date.now() - startedAt).toBeLessThan(2_500);
		await expect(caseAt(mutableFixture(), 13).run()).resolves.toBeUndefined();
	});

	it("rejects arrangement calls outside the selected production inventory", () => {
		const candidate = mutableFixture();
		candidate.trackedFetch = {
			...candidate.trackedFetch,
			arrange: [{ input: {}, operation: "testOnlySetup" }],
		};
		expect(() => createPluginContractCases(candidate as never)).toThrow(
			"Contract call references undeclared operation testOnlySetup",
		);
	});

	it("validates time-advance observation calls against the production inventory", () => {
		const candidate = mutableFixture();
		candidate.durability = {
			...candidate.durability,
			timeAdvance: {
				arrange: [],
				deliveries: { afterArrange: 0, afterCommittedAdvance: 0, afterRecovery: 0 },
				duration: "30d",
				observations: [{ expected: { value: 0 }, read: { input: {}, operation: "testOnlyRead" } }],
			},
		};
		expect(() => createPluginContractCases(candidate as never)).toThrow(
			"Contract call references undeclared operation testOnlyRead",
		);
	});
});

function mutableFixture() {
	return {
		...minimalContractFixture,
		authoring: { ...minimalContractFixture.authoring },
		durability: { ...minimalContractFixture.durability },
		harness: { ...minimalContractFixture.harness },
		hono: { ...minimalContractFixture.hono },
		operations: [...minimalContractFixture.operations] as unknown[],
		trackedFetch: { ...minimalContractFixture.trackedFetch },
	};
}

function caseAt(candidate: ReturnType<typeof mutableFixture>, index: number) {
	const contractCase = createPluginContractCases(candidate as never)[index];
	if (!contractCase) throw new TypeError(`Contract case ${index} is missing.`);
	return contractCase;
}
