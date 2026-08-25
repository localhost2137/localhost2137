import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AtomicFileHandle,
	type AtomicWriteFileSystem,
	writeTextAtomically,
} from "../../src/node/atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("atomic file writes", () => {
	it("replaces a file and leaves no sibling temporary artifact", async () => {
		const directory = await temporaryDirectory();
		const destination = join(directory, "instance.json");
		await writeTextAtomically(destination, "first", { token: () => "first" });
		await writeTextAtomically(destination, "second", { token: () => "second" });

		expect(await readFile(destination, "utf8")).toBe("second");
		await expect(access(`${destination}.tmp-second`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("closes and removes the temporary file when writing fails", async () => {
		const failure = new Error("disk full");
		const handle: AtomicFileHandle = {
			close: vi.fn(async () => undefined),
			sync: vi.fn(async () => undefined),
			writeFile: vi.fn(async () => {
				throw failure;
			}),
		};
		const fileSystem: AtomicWriteFileSystem = {
			open: vi.fn(async () => handle),
			rename: vi.fn(async () => undefined),
			unlink: vi.fn(async () => undefined),
		};

		await expect(
			writeTextAtomically("/virtual/instance.json", "data", {
				fileSystem,
				token: () => "failure",
			}),
		).rejects.toBe(failure);
		expect(handle.close).toHaveBeenCalledOnce();
		expect(fileSystem.unlink).toHaveBeenCalledWith("/virtual/instance.json.tmp-failure");
		expect(fileSystem.rename).not.toHaveBeenCalled();
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-atomic-"));
	temporaryDirectories.push(directory);
	return directory;
}
