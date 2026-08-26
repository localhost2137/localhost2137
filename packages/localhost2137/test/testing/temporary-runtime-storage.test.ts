import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TemporaryRuntimeStorage } from "../../src/testing/temporary-runtime-storage.js";
import { TestRuntimeCleanupError } from "../../src/testing/test-runtime-errors.js";

describe("temporary runtime storage", () => {
	it("removes its exact owned path once", async () => {
		const path = await mkdtemp(join(tmpdir(), "localhost2137-temp-owner-"));
		const removeDirectory = vi.fn(async (ownedPath: string) =>
			rm(ownedPath, { force: true, recursive: true }),
		);
		const storage = await TemporaryRuntimeStorage.create({
			makeDirectory: async () => path,
			removeDirectory,
		});

		const first = storage.remove();
		const second = storage.remove();
		expect(second).toBe(first);
		await first;
		expect(removeDirectory).toHaveBeenCalledOnce();
		expect(removeDirectory).toHaveBeenCalledWith(path);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retains and reports the owned path after failed removal", async () => {
		const path = await mkdtemp(join(tmpdir(), "localhost2137-temp-retained-"));
		const cause = new Error("directory busy");
		const storage = await TemporaryRuntimeStorage.create({
			makeDirectory: async () => path,
			removeDirectory: async () => {
				throw cause;
			},
		});

		const failure = await storage.remove().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TestRuntimeCleanupError);
		expect(failure).toMatchObject({ errors: [cause], retainedStoragePath: path });
		await expect(access(path)).resolves.toBeUndefined();
		await rm(path, { force: true, recursive: true });
	});
});
