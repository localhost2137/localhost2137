import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManifestValidationError } from "../../src/kernel/manifests.js";
import { ManifestReadError, NodeManifestStore } from "../../src/node/manifest-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("NodeManifestStore", () => {
	it("validates before writing and validates every read", async () => {
		const directory = await temporaryDirectory();
		const filePath = join(directory, "nested", "instance.json");
		const store = new NodeManifestStore({ token: () => "manifest" });
		await store.writeInstance(filePath, {
			clock: { mode: "pinned", instantMs: 1_788_000_000_000 },
			configuredServices: ["slack"],
			configFingerprint: `sha256:${"a".repeat(64)}`,
			createdAt: "2026-08-25T12:00:00.000Z",
			id: "dev",
			persistence: "persistent",
			schemaVersion: 2,
			seed: { attempt: 0, status: "unseeded" },
			status: "ready",
		});

		expect(await store.readInstance(filePath)).toMatchObject({ id: "dev", status: "ready" });
		expect(await readFile(filePath, "utf8")).toContain('"schemaVersion": 2');
	});

	it("distinguishes malformed JSON from a schema-incompatible manifest", async () => {
		const directory = await temporaryDirectory();
		const store = new NodeManifestStore();
		const malformed = join(directory, "malformed.json");
		const invalid = join(directory, "invalid.json");
		await writeFile(malformed, "{");
		await writeFile(invalid, JSON.stringify({ schemaVersion: 9 }));

		await expect(store.readInstance(malformed)).rejects.toBeInstanceOf(ManifestReadError);
		await expect(store.readInstance(invalid)).rejects.toBeInstanceOf(ManifestValidationError);
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-manifest-"));
	temporaryDirectories.push(directory);
	return directory;
}
