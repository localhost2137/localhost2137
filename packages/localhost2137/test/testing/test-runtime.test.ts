import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createTestRuntime,
	createTestRuntimeWithDependencies,
} from "../../src/testing/create-test-runtime.js";
import { TemporaryRuntimeStorage } from "../../src/testing/temporary-runtime-storage.js";
import {
	TestInstanceClosedError,
	TestRuntimeCleanupError,
	TestRuntimeClosedError,
} from "../../src/testing/test-runtime-errors.js";
import { testingConfig } from "../fixtures/testing-plugin.js";

describe("test runtime", () => {
	it("binds one OS-assigned server and creates inspectable typed isolated handles", async () => {
		const runtime = await createTestRuntime({
			config: testingConfig,
			port: 0,
			storage: "temporary",
		});
		const first = await runtime.createInstance();
		const second = await runtime.createInstance();

		try {
			expect(new URL(runtime.connection.url).port).not.toBe("0");
			expect(Object.keys(first).sort()).toEqual([
				"clock",
				"destroy",
				"env",
				"fixture",
				"idle",
				"reset",
				"seed",
			]);
			expect(Object.keys(first.fixture).sort()).toEqual(["connection", "increment", "read"]);
			expect(Object.isFrozen(first)).toBe(true);
			expect(Object.getPrototypeOf(first)).toBeNull();

			expect(await first.fixture.increment({ by: 3 })).toEqual({ label: "isolated", value: 3 });
			expect(await second.fixture.read({})).toEqual({ value: 0 });
			expect(first.fixture.connection.apiUrl).toContain(`${runtime.connection.url}/test-`);
			expect(first.env.FIXTURE_API_URL).toBe(first.fixture.connection.apiUrl);

			const publicResponse = await fetch(`${first.fixture.connection.apiUrl}/value`);
			expect(await publicResponse.json()).toMatchObject({ label: "isolated", value: 3 });
			expect(await first.clock.status()).toEqual({
				mode: "pinned",
				now: "2026-01-02T03:04:05.000Z",
			});
			expect(Object.keys(first.clock).sort()).toEqual(["advance", "status"]);
			expect(await first.clock.advance("1d")).toMatchObject({
				from: "2026-01-02T03:04:05.000Z",
				mode: "pinned",
				to: "2026-01-03T03:04:05.000Z",
			});
			expect(await first.clock.status()).toEqual({
				mode: "pinned",
				now: "2026-01-03T03:04:05.000Z",
			});
			expect(await second.clock.status()).toEqual({
				mode: "pinned",
				now: "2026-01-02T03:04:05.000Z",
			});
		} finally {
			await Promise.all([first.destroy(), second.destroy()]);
			await runtime.close();
		}
	});

	it("keeps reset empty unless seed is explicit", async () => {
		const runtime = await createTestRuntime({
			config: testingConfig,
			port: 0,
			storage: "temporary",
		});
		const instance = await runtime.createInstance({ seed: true });
		try {
			expect(await instance.fixture.read({})).toEqual({ value: 7 });
			await instance.fixture.increment({ by: 2 });
			await instance.reset();
			expect(await instance.fixture.read({})).toEqual({ value: 0 });
			await instance.reset({ seed: true });
			expect(await instance.fixture.read({})).toEqual({ value: 7 });
			await expect(instance.seed()).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
		} finally {
			await instance.destroy();
			await runtime.close();
		}
	});

	it("makes destroy and close single-flight and invalidates closed owners", async () => {
		const runtime = await createTestRuntime({
			config: testingConfig,
			port: 0,
			storage: "temporary",
		});
		const instance = await runtime.createInstance();
		const firstDestroy = instance.destroy();
		const secondDestroy = instance.destroy();
		expect(secondDestroy).toBe(firstDestroy);
		await firstDestroy;
		await expect(instance.fixture.read({})).rejects.toBeInstanceOf(TestInstanceClosedError);

		const firstClose = runtime.close();
		const secondClose = runtime.close();
		expect(secondClose).toBe(firstClose);
		await firstClose;
		await expect(runtime.createInstance()).rejects.toBeInstanceOf(TestRuntimeClosedError);
		await expect(runtime.control.listInstances()).rejects.toBeInstanceOf(TestRuntimeClosedError);
	});

	it("removes owned storage even when the test body throws", async () => {
		const storagePath = await mkdtemp(join(tmpdir(), "localhost2137-owned-test-"));
		const runtime = await createOwnedRuntime(storagePath);
		const instance = await runtime.createInstance();
		let assertion: unknown;
		try {
			expect(await instance.fixture.read({})).toEqual({ value: 2137 });
		} catch (cause) {
			assertion = cause;
		} finally {
			await instance.destroy();
			await runtime.close();
		}
		expect(assertion).toBeInstanceOf(Error);
		await expect(access(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reports and retains temporary storage when final removal fails", async () => {
		const storagePath = await mkdtemp(join(tmpdir(), "localhost2137-retained-test-"));
		const removalFailure = new Error("filesystem busy");
		const storage = await TemporaryRuntimeStorage.create({
			makeDirectory: async () => storagePath,
			removeDirectory: async () => {
				throw removalFailure;
			},
		});
		const runtime = await createWithStorage(storage);

		const failure = await runtime.close().catch((cause: unknown) => cause);
		expect(failure).toBeInstanceOf(TestRuntimeCleanupError);
		expect(failure).toMatchObject({ retainedStoragePath: storagePath });
		await expect(access(storagePath)).resolves.toBeUndefined();
		await rm(storagePath, { force: true, recursive: true });
	});

	it("validates every public option before acquiring temporary storage", async () => {
		const createStorage = vi.fn(async () => TemporaryRuntimeStorage.create());
		const invalid = { config: testingConfig, port: 2137, storage: "temporary" };
		await expect(
			Reflect.apply(createTestRuntimeWithDependencies, undefined, [
				invalid,
				{
					createStorage,
					correlationId: randomUUID,
					fetch: globalThis.fetch,
					token: randomUUID,
				},
			]),
		).rejects.toThrow(/port must be exactly 0/);
		expect(createStorage).not.toHaveBeenCalled();
	});

	it("lets close win a concurrent create without publishing a stale handle", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const config = blockingConfig(entered.resolve, release.promise);
		const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
		const creating = runtime.createInstance();
		await entered.promise;
		const closing = runtime.close();
		release.resolve();

		await expect(creating).rejects.toBeInstanceOf(TestRuntimeClosedError);
		await closing;
	});
});

async function createOwnedRuntime(storagePath: string) {
	const storage = await TemporaryRuntimeStorage.create({
		makeDirectory: async () => storagePath,
	});
	return createWithStorage(storage);
}

function createWithStorage(storage: TemporaryRuntimeStorage) {
	return createTestRuntimeWithDependencies(
		{ config: testingConfig, port: 0, storage: "temporary" },
		{
			createStorage: async () => storage,
			correlationId: randomUUID,
			fetch: globalThis.fetch,
			token: randomUUID,
		},
	);
}

function blockingConfig(entered: () => void, release: Promise<void>) {
	type State = Readonly<{ ready: true }>;
	type Config = Readonly<Record<string, never>>;
	const operation = defineOperation<"blocking", State, Config>();
	const read = operation({
		description: "Read state",
		input: z.object({}),
		output: z.object({ ready: z.literal(true) }),
		run: (context) => context.state,
	});
	const plugin = definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({}),
		connection: () => ({ env: {}, values: {} }),
		description: "Blocking start fixture",
		id: "blocking",
		lifecycle: {
			create: () => undefined,
			start: async (): Promise<State> => {
				entered();
				await release;
				return Object.freeze({ ready: true });
			},
		},
		operations: { read },
		stateVersion: 1,
	});
	return defineConfig({ services: { blocking: plugin({ config: {} }) } });
}

function deferred<Value>() {
	let resolvePromise: (value: Value | PromiseLike<Value>) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}
