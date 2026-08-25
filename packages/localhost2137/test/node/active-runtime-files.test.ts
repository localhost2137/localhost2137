import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discoverActiveRuntime,
	discoverRuntimeFiles,
	RuntimeDiscoveryError,
} from "../../src/node/active-runtime-discovery.js";
import {
	ActiveRuntimeFileStore,
	createRuntimeDescriptor,
	generateControlToken,
} from "../../src/node/active-runtime-file-store.js";
import { storagePaths } from "../../src/node/storage-paths.js";

const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const OWNER_ID = "runtime_owner_123456789";
const TOKEN = "control-token-value";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("active runtime files", () => {
	it("publishes a fixed-root token before the discoverability descriptor", async () => {
		const root = await temporaryRoot();
		const store = new ActiveRuntimeFileStore(root);
		const descriptor = fixtureDescriptor();

		await store.publish(descriptor, TOKEN);
		const discovered = await discoverRuntimeFiles(root);

		expect(discovered).toEqual({ descriptor, token: TOKEN });
		expect(Object.isFrozen(discovered)).toBe(true);
		expect(JSON.parse(await readFile(storagePaths(root).runtime, "utf8"))).not.toHaveProperty(
			"token",
		);
		expect(await readFile(storagePaths(root).controlToken, "utf8")).toBe(`${TOKEN}\n`);
		if (process.platform !== "win32") {
			expect((await stat(storagePaths(root).controlToken)).mode & 0o777).toBe(0o600);
		}
	});

	it("only removes files owned by the expected descriptor", async () => {
		const root = await temporaryRoot();
		const store = new ActiveRuntimeFileStore(root);
		await store.publish(fixtureDescriptor(), TOKEN);

		await expect(store.remove("different_owner_123456789")).resolves.toBe(false);
		await expect(discoverRuntimeFiles(root)).resolves.toMatchObject({ token: TOKEN });
		await expect(store.remove(OWNER_ID)).resolves.toBe(true);
		await expect(store.remove(OWNER_ID)).resolves.toBe(false);
		await expect(discoverRuntimeFiles(root)).rejects.toMatchObject({ code: "RUNTIME_NOT_FOUND" });
	});

	it("generates cryptographic token and owner material", () => {
		const first = generateControlToken();
		const second = generateControlToken();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).not.toBe(first);
	});

	it("distinguishes absent, malformed, unsupported, and inconsistent files", async () => {
		const absentRoot = await temporaryRoot();
		await expect(discoverRuntimeFiles(absentRoot)).rejects.toMatchObject({
			code: "RUNTIME_NOT_FOUND",
		});

		const malformedRoot = await temporaryRoot();
		await writeRuntimeFile(malformedRoot, "{not json}");
		await expect(discoverRuntimeFiles(malformedRoot)).rejects.toMatchObject({
			code: "RUNTIME_DESCRIPTOR_MALFORMED",
		});

		const unsupportedRoot = await temporaryRoot();
		await writeRuntimeFile(
			unsupportedRoot,
			JSON.stringify({ ...fixtureDescriptor(), protocolVersion: "v2" }),
		);
		await expect(discoverRuntimeFiles(unsupportedRoot)).rejects.toMatchObject({
			code: "RUNTIME_PROTOCOL_UNSUPPORTED",
		});

		const incompleteRoot = await temporaryRoot();
		await writeRuntimeFile(incompleteRoot, JSON.stringify(fixtureDescriptor()));
		await expect(discoverRuntimeFiles(incompleteRoot)).rejects.toMatchObject({
			code: "RUNTIME_FILES_INCONSISTENT",
		});
	});

	it("does not probe or trust descriptor-controlled token paths", async () => {
		const root = await temporaryRoot();
		await writeRuntimeFile(
			root,
			JSON.stringify({ ...fixtureDescriptor(), tokenPath: "/tmp/untrusted-token" }),
		);
		await writeFile(storagePaths(root).controlToken, `${TOKEN}\n`, { mode: 0o600 });

		await expect(discoverRuntimeFiles(root)).rejects.toMatchObject({
			code: "RUNTIME_DESCRIPTOR_MALFORMED",
		});
	});

	it("reports a stale positive pid before network access and keeps the descriptor", async () => {
		const root = await temporaryRoot();
		await new ActiveRuntimeFileStore(root).publish(fixtureDescriptor(), TOKEN);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const processIsAlive = vi.fn(() => false);

		await expect(discoverActiveRuntime(root, { fetch, processIsAlive })).rejects.toMatchObject({
			code: "RUNTIME_PROCESS_STALE",
		});
		expect(processIsAlive).toHaveBeenCalledWith(21_337);
		expect(fetch).not.toHaveBeenCalled();
		await expect(discoverRuntimeFiles(root)).resolves.toMatchObject({ token: TOKEN });
	});

	it("verifies protocol health and a protected request before returning a client", async () => {
		const root = await temporaryRoot();
		await new ActiveRuntimeFileStore(root).publish(fixtureDescriptor(), TOKEN);
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
			if (url.endsWith("/health")) {
				return jsonResponse({ data: { status: "ok", version: "v1" } });
			}
			expect(url).toBe("http://127.0.0.1:2137/_/v1/instances");
			return jsonResponse({ data: [] });
		});

		const active = await discoverActiveRuntime(root, {
			fetch: fetch as typeof globalThis.fetch,
			processIsAlive: () => true,
		});

		expect(active.descriptor.ownerId).toBe(OWNER_ID);
		expect(active.client.url).toBe("http://127.0.0.1:2137");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("distinguishes failed authenticated readiness without deleting apparently live files", async () => {
		const root = await temporaryRoot();
		await new ActiveRuntimeFileStore(root).publish(fixtureDescriptor(), TOKEN);
		const fetch = vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/health")
				? jsonResponse({ data: { status: "ok", version: "v1" } })
				: jsonResponse(
						{
							error: {
								code: "AUTHENTICATION_REQUIRED",
								correlationId: "correlation-1",
								message: "A valid control bearer token is required.",
							},
						},
						401,
					),
		);

		const failure = await discoverActiveRuntime(root, {
			fetch: fetch as typeof globalThis.fetch,
			processIsAlive: () => true,
		}).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(RuntimeDiscoveryError);
		expect(failure).toMatchObject({ code: "RUNTIME_HEALTH_FAILED" });
		expect((failure as Error).cause).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
		await expect(discoverRuntimeFiles(root)).resolves.toMatchObject({ token: TOKEN });
	});

	it("bounds runtime health discovery", async () => {
		const root = await temporaryRoot();
		await new ActiveRuntimeFileStore(root).publish(fixtureDescriptor(), TOKEN);
		const fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) throw new Error("Expected a bounded discovery signal.");
					const aborted = () => reject(signal.reason);
					signal.addEventListener("abort", aborted, { once: true });
					if (signal.aborted) aborted();
				}),
		);

		await expect(
			discoverActiveRuntime(root, {
				fetch: fetch as typeof globalThis.fetch,
				healthTimeoutMs: 1,
				processIsAlive: () => true,
			}),
		).rejects.toMatchObject({ code: "RUNTIME_HEALTH_FAILED" });
	});
});

function fixtureDescriptor() {
	return createRuntimeDescriptor({
		configFingerprint: FINGERPRINT,
		ownerId: OWNER_ID,
		pid: 21_337,
		startedAt: "2026-08-26T12:00:00.000Z",
		url: "http://127.0.0.1:2137",
	});
}

async function temporaryRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-active-runtime-"));
	directories.push(directory);
	return directory;
}

async function writeRuntimeFile(root: string, content: string): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(storagePaths(root).runtime, content);
}

function jsonResponse(value: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}
