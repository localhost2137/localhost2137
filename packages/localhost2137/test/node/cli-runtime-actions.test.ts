import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { definePlugin } from "../../src/authoring/plugin.js";
import {
	CliConfigMismatchError,
	CliRuntimeUnavailableError,
	CliTargetNotFoundError,
} from "../../src/cli/cli-errors.js";
import { resolveConfig } from "../../src/config/config-resolution.js";
import type { ControlClient } from "../../src/control/control-client.js";
import { ControlApiError } from "../../src/control/control-client-errors.js";
import type { RuntimeDescriptor } from "../../src/control/runtime-descriptor.js";
import { RuntimeDiscoveryError } from "../../src/node/active-runtime-discovery.js";
import { createNodeCliActions } from "../../src/node/cli-runtime-actions.js";

describe("Node CLI runtime actions", () => {
	it("derives env and child overlays locally from the actual discovered URL", async () => {
		const fixture = actionFixture();
		const runChild = vi.fn(async () => 17);
		const actions = createNodeCliActions(fixture.input, {
			discoverRuntime: fixture.discoverRuntime,
			loadConfig: fixture.loadConfig,
			runChild,
		});

		await expect(actions.environment("review", "json")).resolves.toBe(
			'{\n  "FIXTURE_SECRET": "private-value",\n  "FIXTURE_URL": "http://127.0.0.1:42137/review/fixture"\n}\n',
		);
		await expect(actions.run("review", ["node", "app.js"])).resolves.toBe(17);

		expect(fixture.client.getInstance).toHaveBeenCalledTimes(2);
		expect(runChild).toHaveBeenCalledWith({
			argv: ["node", "app.js"],
			connectionEnv: {
				FIXTURE_SECRET: "private-value",
				FIXTURE_URL: "http://127.0.0.1:42137/review/fixture",
			},
			cwd: "/project",
			inheritedEnv: { EXISTING: "yes" },
		});
		expect(fixture.discoverRuntime).toHaveBeenCalledTimes(2);
	});

	it("rejects config drift before dispatching any command", async () => {
		const fixture = actionFixture();
		fixture.descriptor.configFingerprint = `sha256:${"f".repeat(64)}`;
		const runChild = vi.fn(async () => 0);
		const actions = createNodeCliActions(fixture.input, {
			discoverRuntime: fixture.discoverRuntime,
			loadConfig: fixture.loadConfig,
			runChild,
		});

		await expect(actions.environment("dev", "json")).rejects.toBeInstanceOf(CliConfigMismatchError);
		await expect(actions.run("dev", ["node", "app.js"])).rejects.toBeInstanceOf(
			CliConfigMismatchError,
		);
		expect(fixture.client.listInstances).not.toHaveBeenCalled();
		expect(fixture.client.getInstance).not.toHaveBeenCalled();
		expect(fixture.connection).not.toHaveBeenCalled();
		expect(runChild).not.toHaveBeenCalled();
	});

	it("turns discovery failures into one actionable dev instruction", async () => {
		const fixture = actionFixture();
		const cause = new RuntimeDiscoveryError("RUNTIME_NOT_FOUND", "No runtime descriptor.");
		fixture.discoverRuntime.mockRejectedValue(cause);
		const actions = createNodeCliActions(fixture.input, {
			discoverRuntime: fixture.discoverRuntime,
			loadConfig: fixture.loadConfig,
		});

		const failure = await actions.listInstances().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CliRuntimeUnavailableError);
		expect((failure as Error).message.match(/localhost dev/g)).toHaveLength(1);
		expect(failure).toMatchObject({ cause });
	});

	it("adds existing instances to unknown-target diagnostics", async () => {
		const fixture = actionFixture();
		const missing = new ControlApiError({
			code: "INSTANCE_NOT_FOUND",
			correlationId: "correlation-1",
			message: "Instance not found.",
			status: 404,
		});
		fixture.client.logs.mockRejectedValue(missing);
		fixture.client.listInstances.mockResolvedValue([{ id: "dev" }, { id: "review" }]);
		const actions = createNodeCliActions(fixture.input, {
			discoverRuntime: fixture.discoverRuntime,
			loadConfig: fixture.loadConfig,
		});

		const failure = await actions
			.logs({ instanceId: "nope", tail: 5 })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CliTargetNotFoundError);
		expect((failure as Error).message).toBe(
			'no instance "nope" (existing: dev, review)\nhint: localhost instance create nope',
		);
		expect(failure).toMatchObject({ cause: missing, instanceId: "nope" });
	});

	it("owns dynamic service descriptions and operation input before use", async () => {
		const fixture = actionFixture();
		fixture.client.describeService.mockResolvedValue({
			description: "Fixture service",
			name: "fixture",
			operationMetadata: {},
			operations: [],
			pluginId: "fixture",
			stateVersion: 1,
			status: "running",
		});
		const actions = createNodeCliActions(fixture.input, {
			discoverRuntime: fixture.discoverRuntime,
			loadConfig: fixture.loadConfig,
		});

		await expect(actions.describeService("dev", "fixture")).resolves.toEqual({
			description: "Fixture service",
			name: "fixture",
			operationMetadata: {},
		});
		await expect(actions.describe("dev", "fixture")).resolves.toEqual({
			description: "Fixture service",
			name: "fixture",
			operations: {},
		});
		const operationInput: Record<string, unknown> = {};
		Object.defineProperty(operationInput, "value", { enumerable: true, get: vi.fn() });
		await expect(
			actions.execute({
				input: operationInput,
				instanceId: "dev",
				operationKey: "inspect",
				serviceKey: "fixture",
			}),
		).rejects.toThrow("data property");
		expect(fixture.client.executeOperation).not.toHaveBeenCalled();
	});

	it("binds one explicit config locator into sessions, dev, and doctor", async () => {
		const fixture = actionFixture();
		const configPath = "/outside/custom.localhost.ts";
		const inspectRuntime = vi.fn(async () => ({ status: "ok" as const }));
		const runDev = vi.fn(async () => undefined);
		const actions = createNodeCliActions(
			{ ...fixture.input, configPath },
			{
				discoverRuntime: fixture.discoverRuntime,
				inspectRuntime,
				loadConfig: fixture.loadConfig,
				runDev,
			},
		);

		await actions.listInstances();
		await actions.dev({ port: 2_138 });
		await actions.doctor();

		expect(fixture.loadConfig).toHaveBeenCalledWith({
			cwd: "/project",
			explicitPath: configPath,
		});
		expect(runDev).toHaveBeenCalledWith(
			{
				configPath,
				cwd: "/project",
				io: fixture.input.io,
				options: { port: 2_138 },
			},
			expect.objectContaining({ startDaemon: expect.any(Function) }),
		);
		expect(inspectRuntime).toHaveBeenCalledWith({ configPath, cwd: "/project" });
	});
});

function actionFixture() {
	const connection = vi.fn(
		({
			baseUrl,
			config,
			instanceId,
			serviceKey,
		}: {
			baseUrl: string;
			config: { secret: string };
			instanceId: string;
			serviceKey: string;
		}) => ({
			env: {
				FIXTURE_SECRET: config.secret,
				FIXTURE_URL: `${baseUrl}/${instanceId}/${serviceKey}`,
			},
			values: { secret: config.secret, url: `${baseUrl}/${instanceId}/${serviceKey}` },
		}),
	);
	const plugin = definePlugin({
		api: new Hono(),
		configSchema: z.object({ secret: z.string() }),
		connection,
		description: "Fixture service",
		id: "fixture",
		lifecycle: { create: () => undefined, start: () => ({}) },
		operations: {},
		stateVersion: 1,
	});
	const config = resolveConfig(
		{
			services: { fixture: plugin({ config: { secret: "private-value" } }) },
			storage: { dir: "/project/.state" },
		},
		join("/project", "localhost.config.ts"),
	);
	connection.mockClear();
	const mutableDescriptor = {
		configFingerprint: config.fingerprint,
		ownerId: "owner_0123456789012345",
		pid: 12_345,
		protocolVersion: "v1" as const,
		schemaVersion: 1 as const,
		startedAt: "2026-08-26T00:00:00.000Z",
		url: "http://127.0.0.1:42137",
	};
	const client = {
		clockStatus: vi.fn(),
		createInstance: vi.fn(),
		describeService: vi.fn(),
		destroyInstance: vi.fn(),
		executeOperation: vi.fn(),
		getInstance: vi.fn(async () => ({ id: "dev" })),
		listInstances: vi.fn(),
		listServices: vi.fn(),
		logs: vi.fn(),
		resetInstance: vi.fn(),
		seedInstance: vi.fn(),
	} as unknown as MockControlClient;
	const discoverRuntime = vi.fn(async () => ({
		client: client as unknown as ControlClient,
		descriptor: mutableDescriptor as RuntimeDescriptor,
		token: "private-control-token",
	}));
	return {
		client,
		connection,
		descriptor: mutableDescriptor,
		discoverRuntime,
		input: {
			cwd: "/project",
			inheritedEnv: { EXISTING: "yes" },
			io: { writeError: vi.fn(), writeOutput: vi.fn() },
		},
		loadConfig: vi.fn(async () => config),
	};
}

type MockControlClient = {
	readonly [Key in keyof ControlClient]: ControlClient[Key] extends (
		...arguments_: infer Arguments
	) => infer Result
		? ReturnType<typeof vi.fn<(...arguments_: Arguments) => Result>>
		: ControlClient[Key];
};
