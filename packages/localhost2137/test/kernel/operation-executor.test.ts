import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RunningPluginContext } from "../../src/authoring/context.js";
import type { LocalhostError } from "../../src/authoring/localhost-error.js";
import { defineOperation } from "../../src/authoring/operation.js";
import {
	OperationExecutor,
	OperationNotFoundError,
	OperationRunner,
} from "../../src/kernel/operation-executor.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";

const defineFixtureOperation = defineOperation<
	"fixture",
	{ calls: string[] },
	{ prefix: string }
>();

function fixtureContext(): RunningPluginContext<unknown, unknown> {
	return Object.freeze({
		clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
		config: Object.freeze({ prefix: "hello" }),
		fetch: async () => new Response(null, { status: 204 }),
		instanceId: "dev",
		log: { info: vi.fn() },
		serviceKey: "fixture",
		signal: new AbortController().signal,
		state: { calls: [] },
		storage: { path: (path) => `/tmp/${path}` },
		tasks: { track: async (_label, task) => task },
	});
}

function fixtureRunner(): Readonly<{ logs: StructuredLogRing; runner: OperationRunner }> {
	let now = 1_000;
	let correlation = 0;
	const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
	return {
		logs,
		runner: new OperationRunner({
			correlationId: () => `correlation-${++correlation}`,
			time: {
				nowMilliseconds: () => ++now,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		}),
	};
}

describe("OperationRunner", () => {
	it("validates input and output and returns an owned JSON value", async () => {
		const operation = defineFixtureOperation({
			description: "greet",
			input: z.object({ name: z.string(), suffix: z.string().default("!") }),
			output: z.object({ greeting: z.string() }),
			run: (context, input) => ({
				greeting: `${context.config.prefix} ${input.name}${input.suffix}`,
			}),
		});
		const { logs, runner } = fixtureRunner();

		const result = await runner.run({
			context: fixtureContext(),
			instanceId: "dev",
			logs,
			operation,
			operationKey: "greet",
			rawInput: { name: "Ada" },
			serviceKey: "fixture",
		});

		expect(result).toEqual({ greeting: "hello Ada!" });
		expect(Object.isFrozen(result)).toBe(true);
		expect(logs.snapshot().entries.map(({ status }) => status)).toEqual(["started", "succeeded"]);
	});

	it("returns stable field issues without invoking invalid input", async () => {
		const run = vi.fn();
		const operation = defineFixtureOperation({
			description: "greet",
			input: z.object({ name: z.string() }),
			output: z.null(),
			run,
		});
		const { logs, runner } = fixtureRunner();

		const failure = await runner
			.run({
				context: fixtureContext(),
				instanceId: "dev",
				logs,
				operation,
				operationKey: "greet",
				rawInput: { name: 42 },
				serviceKey: "fixture",
			})
			.catch((cause: unknown) => cause);

		expect(failure).toMatchObject({
			code: "INVALID_OPERATION_INPUT",
			correlationId: "correlation-1",
			status: 400,
		});
		expect((failure as LocalhostError).details).toMatchObject({
			issues: [{ path: ["name"] }],
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("hides unknown plugin failures but retains their cause in the failed log", async () => {
		const secretFailure = new Error("secret token xoxb-do-not-expose");
		const operation = defineFixtureOperation({
			description: "fail",
			input: z.object({}),
			output: z.null(),
			run: () => {
				throw secretFailure;
			},
		});
		const { logs, runner } = fixtureRunner();

		const failure = await runner
			.run({
				context: fixtureContext(),
				instanceId: "dev",
				logs,
				operation,
				operationKey: "fail",
				rawInput: {},
				serviceKey: "fixture",
			})
			.catch((cause: unknown) => cause);

		expect(failure).toMatchObject({
			code: "PLUGIN_EXECUTION_FAILED",
			message: "The plugin operation failed.",
			status: 500,
		});
		expect(JSON.stringify(failure)).not.toContain("xoxb-do-not-expose");
		expect(logs.snapshot().entries.at(-1)).toMatchObject({
			attributes: { code: "PLUGIN_EXECUTION_FAILED" },
			status: "failed",
		});
	});

	it("rejects schema-accepted values that are not JSON-compatible", async () => {
		const operation = defineFixtureOperation({
			description: "date",
			input: z.object({}),
			output: z.any(),
			run: () => new Date("2026-08-25T12:00:00.000Z"),
		});
		const { logs, runner } = fixtureRunner();

		await expect(
			runner.run({
				context: fixtureContext(),
				instanceId: "dev",
				logs,
				operation,
				operationKey: "date",
				rawInput: {},
				serviceKey: "fixture",
			}),
		).rejects.toMatchObject({ code: "OPERATION_OUTPUT_INVALID", status: 500 });
	});
});

describe("OperationExecutor", () => {
	it("acquires and always releases the running service lease", async () => {
		const operation = defineFixtureOperation({
			description: "noop",
			input: z.object({}),
			output: z.object({ ok: z.literal(true) }),
			run: () => ({ ok: true as const }),
		});
		const release = vi.fn();
		const { logs, runner } = fixtureRunner();
		const executor = new OperationExecutor(
			{
				acquireService: async () => ({ context: fixtureContext(), logs, release }),
			},
			{ resolve: () => operation },
			runner,
		);

		await expect(
			executor.execute({
				instanceId: "dev",
				operationKey: "noop",
				rawInput: {},
				serviceKey: "fixture",
			}),
		).resolves.toEqual({ ok: true });
		expect(release).toHaveBeenCalledOnce();
	});

	it("fails before acquiring a lease when an operation does not exist", async () => {
		const acquireService = vi.fn();
		const { runner } = fixtureRunner();
		const executor = new OperationExecutor(
			{ acquireService },
			{ resolve: () => undefined },
			runner,
		);

		await expect(
			executor.execute({
				instanceId: "dev",
				operationKey: "missing",
				rawInput: {},
				serviceKey: "fixture",
			}),
		).rejects.toBeInstanceOf(OperationNotFoundError);
		expect(acquireService).not.toHaveBeenCalled();
	});
});
