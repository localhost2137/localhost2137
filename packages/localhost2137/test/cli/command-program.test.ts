import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineOperation } from "../../src/authoring/operation.js";
import type { CliActions, CliIo } from "../../src/cli/cli-actions.js";
import { runCliCommand } from "../../src/cli/command-program.js";
import { ownCliServiceDescription } from "../../src/cli/service-description.js";
import { createOperationMetadata } from "../../src/config/schema-metadata.js";
import { ControlApiError, ControlTransportError } from "../../src/control/control-client-errors.js";
import { CliUsageError } from "../../src/cli/cli-errors.js";

describe("CLI command program", () => {
	it("emits valid stdout-only JSON for every --json command", async () => {
		for (const arguments_ of [
			["describe", "--json"],
			["describe", "fixture", "--json"],
			["exec", "fixture", "inspect", "--json"],
			["instance", "list", "--json"],
			["logs", "--json"],
			["clock", "status", "--json"],
			["clock", "advance", "30d", "--json"],
			["doctor", "--json"],
		]) {
			const fixture = cliFixture();
			const exitCode = await runCliCommand({
				arguments: arguments_,
				createActions: () => fixture.actions,
				defaultInstance: "dev",
				io: fixture.io,
			});

			expect(exitCode, arguments_.join(" ")).toBe(0);
			expect(() => JSON.parse(fixture.stdout)).not.toThrow();
			expect(fixture.stderr).toBe("");
		}
	});

	it("dispatches the complete static v0.1 command surface", async () => {
		const fixture = cliFixture();
		const commands: readonly (readonly string[])[] = [
			["dev", "--config", "other.ts", "--host", "::1", "--port", "2138"],
			["instance", "create", "review", "--seed"],
			["instance", "reset", "review", "--seed"],
			["instance", "destroy", "review"],
			["seed", "--instance", "review"],
			["env", "--instance", "review", "--format", "dotenv"],
			["logs", "fixture", "--instance", "review", "--tail", "5"],
			["clock", "advance", "30d", "--instance", "review"],
		];
		for (const arguments_ of commands) {
			expect(
				await runCliCommand({
					arguments: arguments_,
					createActions: () => fixture.actions,
					defaultInstance: "dev",
					io: fixture.io,
				}),
			).toBe(0);
		}

		expect(fixture.actions.dev).toHaveBeenCalledWith({
			host: "::1",
			port: 2138,
		});
		expect(fixture.actions.createInstance).toHaveBeenCalledWith("review", true);
		expect(fixture.actions.resetInstance).toHaveBeenCalledWith("review", true);
		expect(fixture.actions.destroyInstance).toHaveBeenCalledWith("review");
		expect(fixture.actions.seed).toHaveBeenCalledWith("review");
		expect(fixture.actions.environment).toHaveBeenCalledWith("review", "dotenv");
		expect(fixture.actions.logs).toHaveBeenCalledWith({
			instanceId: "review",
			serviceKey: "fixture",
			tail: 5,
		});
		expect(fixture.actions.advanceClock).toHaveBeenCalledWith("review", "30d");
	});

	it("initializes a project without loading a runtime config", async () => {
		const fixture = cliFixture();
		fixture.actions.initProject.mockResolvedValue({
			gitignore: "updated",
		});
		const createActions = vi.fn(() => fixture.actions);

		const exitCode = await runCliCommand({
			arguments: ["init"],
			createActions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(0);
		expect(createActions).toHaveBeenCalledWith({});
		expect(fixture.actions.initProject).toHaveBeenCalledOnce();
		expect(fixture.stdout).toBe(
			"Created localhost.config.ts\nUpdated .gitignore\n\nNext:\n  Install localhost2137 and an emulator plugin with pnpm.\n  Add the plugin to localhost.config.ts.\n  pnpm exec localhost dev\n",
		);
		expect(fixture.stderr).toBe("");
	});

	it("keeps init help config-independent and rejects extra arguments", async () => {
		for (const [arguments_, expectedExit] of [
			[["init", "--help"], 0],
			[["init", "extra"], 2],
		] as const) {
			const fixture = cliFixture();
			const exitCode = await runCliCommand({
				arguments: arguments_,
				createActions: () => fixture.actions,
				defaultInstance: "dev",
				io: fixture.io,
			});
			expect(exitCode).toBe(expectedExit);
			expect(fixture.actions.initProject).not.toHaveBeenCalled();
		}
	});

	it("renders project conflicts as usage failures without stdout", async () => {
		const fixture = cliFixture();
		fixture.actions.initProject.mockRejectedValue(
			new CliUsageError("Refusing to replace existing localhost2137 config: localhost.config.ts"),
		);

		const exitCode = await runCliCommand({
			arguments: ["init"],
			createActions: () => fixture.actions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(2);
		expect(fixture.stdout).toBe("");
		expect(fixture.stderr).toContain("Refusing to replace existing");
	});

	it("rejects a config selector for project initialization", async () => {
		const fixture = cliFixture();

		const exitCode = await runCliCommand({
			arguments: ["--config", "elsewhere.ts", "init"],
			createActions: () => fixture.actions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(2);
		expect(fixture.actions.initProject).not.toHaveBeenCalled();
		expect(fixture.stdout).toBe("");
		expect(fixture.stderr).toContain("--config does not apply to localhost init");
	});

	it("passes run argv directly and returns the child exit code", async () => {
		const fixture = cliFixture();
		fixture.actions.run.mockResolvedValue(17);

		const exitCode = await runCliCommand({
			arguments: [
				"run",
				"--instance",
				"review",
				"--",
				"node",
				"-e",
				'console.log("$HOME && literal")',
				"--config",
				"child-config.ts",
				"--config=child-equal.ts",
			],
			createActions: () => fixture.actions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(17);
		expect(fixture.actions.run).toHaveBeenCalledWith("review", [
			"node",
			"-e",
			'console.log("$HOME && literal")',
			"--config",
			"child-config.ts",
			"--config=child-equal.ts",
		]);
		expect(fixture.stdout).toBe("");
	});

	it("binds stripped global config state before dispatching dev", async () => {
		const fixture = cliFixture();
		const createActions = vi.fn(() => fixture.actions);

		const exitCode = await runCliCommand({
			arguments: ["dev", "--port", "2138", "--config=custom.localhost.ts"],
			createActions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(0);
		expect(createActions).toHaveBeenCalledWith({ configPath: "custom.localhost.ts" });
		expect(fixture.actions.dev).toHaveBeenCalledWith({ port: 2138 });
	});

	it("shows the global config locator in root and subcommand help", async () => {
		for (const arguments_ of [
			["--help"],
			["doctor", "--help"],
			["instance", "list", "--help"],
			["exec", "--help"],
			["exec", "fixture", "--help"],
			["exec", "fixture", "inspect", "--help"],
		]) {
			const fixture = cliFixture();
			const exitCode = await runCliCommand({
				arguments: arguments_,
				createActions: () => fixture.actions,
				defaultInstance: "dev",
				io: fixture.io,
			});

			expect(exitCode, arguments_.join(" ")).toBe(0);
			expect(fixture.stdout, arguments_.join(" ")).toContain("--config <path>");
		}
	});

	it("maps stable runtime error classes without contaminating stdout", async () => {
		const cases = [
			[
				new ControlApiError({
					code: "INVALID_OPERATION_INPUT",
					correlationId: "correlation-1",
					message: "Invalid input.",
					status: 400,
				}),
				2,
			],
			[
				new ControlApiError({
					code: "SERVICE_NOT_FOUND",
					correlationId: "correlation-2",
					message: "Missing.",
					status: 404,
				}),
				4,
			],
			[
				new ControlApiError({
					code: "LIFECYCLE_CONFLICT",
					correlationId: "correlation-3",
					message: "Conflict.",
					status: 409,
				}),
				5,
			],
			[
				new ControlApiError({
					code: "PLUGIN_EXECUTION_FAILED",
					correlationId: "correlation-4",
					message: "Plugin failed.",
					status: 500,
				}),
				10,
			],
			[new ControlTransportError(new Error("offline"), false), 3],
		] as const;

		for (const [failure, expectedExit] of cases) {
			const fixture = cliFixture();
			fixture.actions.listInstances.mockRejectedValue(failure);
			const exitCode = await runCliCommand({
				arguments: ["instance", "list", "--json"],
				createActions: () => fixture.actions,
				defaultInstance: "dev",
				io: fixture.io,
			});

			expect(exitCode).toBe(expectedExit);
			expect(fixture.stdout).toBe("");
			expect(fixture.stderr).toMatch(/^error: /);
		}
	});

	it("returns not-found only for an unknown operation on a described service", async () => {
		const missing = cliFixture();
		const missingExit = await runCliCommand({
			arguments: ["exec", "fixture", "missing-operation"],
			createActions: () => missing.actions,
			defaultInstance: "dev",
			io: missing.io,
		});

		expect(missingExit).toBe(4);
		expect(missing.actions.describeService).toHaveBeenCalledWith("dev", "fixture");
		expect(missing.actions.execute).not.toHaveBeenCalled();
		expect(missing.stdout).toBe("");

		const malformed = cliFixture();
		const malformedExit = await runCliCommand({
			arguments: ["exec", "fixture", "inspect", "--unknown-flag"],
			createActions: () => malformed.actions,
			defaultInstance: "dev",
			io: malformed.io,
		});

		expect(malformedExit).toBe(2);
		expect(malformed.actions.execute).not.toHaveBeenCalled();
	});

	it("does not preselect an exec instance from text after the option delimiter", async () => {
		const fixture = cliFixture();

		const exitCode = await runCliCommand({
			arguments: ["exec", "fixture", "inspect", "--", "--instance", "nope"],
			createActions: () => fixture.actions,
			defaultInstance: "dev",
			io: fixture.io,
		});

		expect(exitCode).toBe(2);
		expect(fixture.actions.describeService).toHaveBeenCalledWith("dev", "fixture");
		expect(fixture.actions.execute).not.toHaveBeenCalled();
	});

	it("keeps destructive targets explicit and excludes deferred commands", async () => {
		for (const arguments_ of [
			["instance", "destroy"],
			["instance", "reset"],
			["clock", "advance"],
			["snapshot", "save", "name"],
		]) {
			const fixture = cliFixture();
			const exitCode = await runCliCommand({
				arguments: arguments_,
				createActions: () => fixture.actions,
				defaultInstance: "dev",
				io: fixture.io,
			});
			expect(exitCode).toBe(2);
			expect(fixture.actions.destroyInstance).not.toHaveBeenCalled();
			expect(fixture.actions.resetInstance).not.toHaveBeenCalled();
		}
	});

	it("does not leak Commander state between invocations", async () => {
		const first = cliFixture();
		const second = cliFixture();

		expect(
			await runCliCommand({
				arguments: ["logs", "--tail", "7"],
				createActions: () => first.actions,
				defaultInstance: "first",
				io: first.io,
			}),
		).toBe(0);
		expect(
			await runCliCommand({
				arguments: ["logs"],
				createActions: () => second.actions,
				defaultInstance: "second",
				io: second.io,
			}),
		).toBe(0);

		expect(first.actions.logs).toHaveBeenCalledWith({ instanceId: "first", tail: 7 });
		expect(second.actions.logs).toHaveBeenCalledWith({ instanceId: "second", tail: 50 });
	});
});

interface CliFixture {
	readonly actions: MockActions;
	readonly io: CliIo;
	readonly stderr: string;
	readonly stdout: string;
}

type MockActions = {
	readonly [Key in keyof CliActions]: ReturnType<typeof vi.fn<CliActions[Key]>>;
};

function cliFixture(): CliFixture {
	let stdout = "";
	let stderr = "";
	const actions: MockActions = {
		advanceClock: vi.fn(async () => ({
			advanceId: "advance_12345678",
			from: "2026-08-25T12:00:00.000Z",
			mode: "real",
			to: "2026-09-24T12:00:00.000Z",
		})),
		clockStatus: vi.fn(async () => ({ mode: "real", now: "2026-08-25T12:00:00.000Z" })),
		createInstance: vi.fn(async () => ({ id: "review" })),
		describe: vi.fn(async () => ({ services: ["fixture"] })),
		describeService: vi.fn(async () => serviceDescription()),
		destroyInstance: vi.fn(async () => undefined),
		dev: vi.fn(async () => undefined),
		doctor: vi.fn(async () => ({ status: "ok" })),
		environment: vi.fn(async (_instance, format) =>
			format === "json" ? '{"FIXTURE_URL":"http://local"}\n' : 'FIXTURE_URL="http://local"\n',
		),
		execute: vi.fn(async () => ({ ok: true })),
		initProject: vi.fn(async () => ({
			gitignore: "unchanged",
		})),
		listInstances: vi.fn(async () => [{ id: "dev" }]),
		logs: vi.fn(async () => ({ droppedEntries: 0, entries: [] })),
		resetInstance: vi.fn(async () => ({ id: "review" })),
		run: vi.fn(async () => 0),
		seed: vi.fn(async () => undefined),
	};
	return {
		actions,
		io: {
			writeError(value) {
				stderr += value;
			},
			writeOutput(value) {
				stdout += value;
			},
		},
		get stderr() {
			return stderr;
		},
		get stdout() {
			return stdout;
		},
	};
}

function serviceDescription() {
	const operation = defineOperation<"fixture", object, object>()({
		description: "Inspect fixture",
		input: z.object({}),
		output: z.object({ ok: z.boolean() }),
		run: () => ({ ok: true }),
	});
	return ownCliServiceDescription({
		description: "Fixture service",
		name: "fixture",
		operationMetadata: { inspect: createOperationMetadata(operation) },
		operations: ["inspect"],
		pluginId: "fixture",
		stateVersion: 1,
		status: "running",
	});
}
