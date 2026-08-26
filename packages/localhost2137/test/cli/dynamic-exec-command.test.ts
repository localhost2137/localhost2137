import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation } from "../../src/authoring/operation.js";
import { type DynamicExecIo, parseDynamicExecCommand } from "../../src/cli/dynamic-exec-command.js";
import {
	type CliServiceDescription,
	ownCliServiceDescription,
} from "../../src/cli/service-description.js";
import { createOperationMetadata, toCliName } from "../../src/config/schema-metadata.js";

describe("dynamic exec command", () => {
	it("generates typed flags and omits schema defaults that the executor owns", async () => {
		const fixture = io();
		const service = serviceDescription({
			createHTTPUser: operationMetadata(
				z.object({
					admin: z.boolean().default(false),
					count: z.number().int(),
					mode: z.enum(["active", "disabled"]),
					name: z.string().describe("Display name"),
					tags: z.array(z.string()).optional(),
				}),
			),
		});

		const result = await parseDynamicExecCommand(
			service,
			[
				"create-http-user",
				"--name",
				"Ada",
				"--count",
				"2",
				"--mode",
				"active",
				"--admin=false",
				"--tags",
				"one",
				"--tags",
				"two",
				"--instance",
				"pr-1",
				"--json",
			],
			{ defaultInstance: "dev", io: fixture },
		);

		expect(result).toEqual({
			exitCode: 0,
			invocation: {
				input: { admin: false, count: 2, mode: "active", name: "Ada", tags: ["one", "two"] },
				instanceId: "pr-1",
				json: true,
				operationKey: "createHTTPUser",
				serviceKey: "fixture",
			},
		});
		expect(fixture.error).toBe("");
	});

	it("keeps service help discoverable and creates fresh state per invocation", async () => {
		const service = serviceDescription({ listURLValues: operationMetadata(z.object({})) });
		const first = io();
		const second = io();

		const firstResult = await parseDynamicExecCommand(service, ["--help"], {
			defaultInstance: "dev",
			io: first,
		});
		const secondResult = await parseDynamicExecCommand(service, [], {
			defaultInstance: "other",
			io: second,
		});

		expect(firstResult).toEqual({ exitCode: 0 });
		expect(secondResult).toEqual({ exitCode: 0 });
		expect(first.output).toContain("list-url-values");
		expect(second.output).toContain("list-url-values");
		expect(toCliName("listURLValues")).toBe("list-url-values");
	});

	it("uses JSON fallback for unsupported and adapter-colliding fields", async () => {
		for (const [name, schema] of [
			["nested", z.object({ nested: z.object({ value: z.string() }) })],
			["reserved", z.object({ instance: z.string() })],
		] as const) {
			const service = serviceDescription({ [name]: operationMetadata(schema) });
			const missing = io();
			const missingResult = await parseDynamicExecCommand(service, [name], {
				defaultInstance: "dev",
				io: missing,
			});
			const supplied = io();
			const suppliedResult = await parseDynamicExecCommand(
				service,
				[
					name,
					"--input-json",
					JSON.stringify(name === "nested" ? { nested: { value: "ok" } } : { instance: "input" }),
				],
				{ defaultInstance: "dev", io: supplied },
			);

			expect(missingResult.exitCode).toBe(2);
			expect(missing.error).toContain("requires --input-json");
			expect(suppliedResult.invocation?.input).toEqual(
				name === "nested" ? { nested: { value: "ok" } } : { instance: "input" },
			);
		}
	});

	it("reports invalid scalar, enum, JSON, and mixed input as usage errors", async () => {
		const service = serviceDescription({
			create: operationMetadata(z.object({ count: z.number().int(), mode: z.enum(["on", "off"]) })),
		});
		for (const arguments_ of [
			["create", "--count", "1.5", "--mode", "on"],
			["create", "--count", "1", "--mode", "maybe"],
			["create", "--input-json", "not-json"],
			["create", "--input-json", "{}", "--count", "1", "--mode", "on"],
		]) {
			const fixture = io();
			const result = await parseDynamicExecCommand(service, arguments_, {
				defaultInstance: "dev",
				io: fixture,
			});
			expect(result.exitCode).toBe(2);
			expect(fixture.error).not.toBe("");
		}
	});

	it("classifies only an unknown operation subcommand as not found", async () => {
		const service = serviceDescription({
			inspect: operationMetadata(z.object({ message: z.string() })),
		});
		const unknownOperation = io();
		const unknownResult = await parseDynamicExecCommand(service, ["missing-operation"], {
			defaultInstance: "dev",
			io: unknownOperation,
		});

		expect(unknownResult).toEqual({ exitCode: 4 });
		expect(unknownOperation.error).toContain("unknown command 'missing-operation'");
		expect(unknownOperation.output).toBe("");

		for (const arguments_ of [["inspect"], ["inspect", "--message", "ok", "--unknown-flag"]]) {
			const malformed = io();
			const result = await parseDynamicExecCommand(service, arguments_, {
				defaultInstance: "dev",
				io: malformed,
			});
			expect(result.exitCode).toBe(2);
			expect(malformed.error).not.toBe("");
		}
	});

	it("strictly owns control-provided service metadata", () => {
		const metadata = operationMetadata(z.object({}));
		const raw = {
			description: "Fixture",
			name: "fixture",
			operationMetadata: { inspect: metadata },
			operations: ["inspect"],
			pluginId: "fixture",
			stateVersion: 1,
			status: "running",
		};

		const owned = ownCliServiceDescription(raw);
		Reflect.set(raw.operationMetadata, "inspect", null);

		expect(owned.operationMetadata.inspect).toEqual(metadata);
		expect(Object.isFrozen(owned.operationMetadata.inspect)).toBe(true);
		expect(() => ownCliServiceDescription({ ...raw, unexpected: true })).toThrow(
			"Unexpected field",
		);
	});
});

function operationMetadata(input: z.ZodObject): ReturnType<typeof createOperationMetadata> {
	const operation = defineOperation<"fixture", object, object>()({
		description: "Fixture operation",
		input,
		output: z.object({ ok: z.boolean() }),
		run: () => ({ ok: true }),
	});
	return createOperationMetadata(operation);
}

function serviceDescription(
	operations: Readonly<Record<string, ReturnType<typeof createOperationMetadata>>>,
): CliServiceDescription {
	return ownCliServiceDescription({
		description: "Fixture service",
		name: "fixture",
		operationMetadata: operations,
		operations: Object.keys(operations),
		pluginId: "fixture",
		stateVersion: 1,
		status: "running",
	});
}

interface CapturedIo extends DynamicExecIo {
	readonly error: string;
	readonly output: string;
}

function io(): CapturedIo {
	let error = "";
	let output = "";
	return {
		get error() {
			return error;
		},
		get output() {
			return output;
		},
		writeError(value) {
			error += value;
		},
		writeOutput(value) {
			output += value;
		},
	};
}
