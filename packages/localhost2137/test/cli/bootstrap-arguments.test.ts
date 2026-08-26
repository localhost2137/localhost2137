import { describe, expect, it } from "vitest";
import { parseCliBootstrapArguments } from "../../src/cli/bootstrap-arguments.js";

describe("CLI bootstrap arguments", () => {
	it.each([
		{
			arguments: ["--config", "custom.ts", "exec", "fixture", "inspect"],
			expected: ["exec", "fixture", "inspect"],
		},
		{
			arguments: ["exec", "--config=custom.ts", "fixture", "inspect"],
			expected: ["exec", "fixture", "inspect"],
		},
		{
			arguments: ["exec", "fixture", "inspect", "--config", "custom.ts", "--json"],
			expected: ["exec", "fixture", "inspect", "--json"],
		},
	])("owns separate/equal global config syntax at command-friendly positions", (fixture) => {
		const parsed = parseCliBootstrapArguments(fixture.arguments);

		expect(parsed).toEqual({ arguments: fixture.expected, configPath: "custom.ts" });
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.arguments)).toBe(true);
	});

	it.each([["--config"], ["--config="], ["--config", "--json"], ["--config", "--"]])(
		"rejects a missing config path in %j",
		(...arguments_) => {
			expect(() => parseCliBootstrapArguments(arguments_)).toThrow("--config requires a path");
		},
	);

	it.each([
		["--config", "first.ts", "--config", "second.ts", "doctor"],
		["exec", "--config=first.ts", "fixture", "--config=second.ts", "inspect"],
	])("rejects duplicate config locators in %j", (...arguments_) => {
		expect(() => parseCliBootstrapArguments(arguments_)).toThrow(
			"--config may be specified only once",
		);
	});

	it("preserves the delimiter and every child argument after it", () => {
		const parsed = parseCliBootstrapArguments([
			"--config",
			"runtime.ts",
			"run",
			"--",
			"node",
			"--config",
			"child.ts",
			"--config=child-equal.ts",
		]);

		expect(parsed).toEqual({
			arguments: ["run", "--", "node", "--config", "child.ts", "--config=child-equal.ts"],
			configPath: "runtime.ts",
		});
	});

	it("does not retain references to mutable caller argv", () => {
		const arguments_ = ["--config", "custom.ts", "doctor"];
		const parsed = parseCliBootstrapArguments(arguments_);

		arguments_[2] = "destroy";
		expect(parsed.arguments).toEqual(["doctor"]);
	});
});
