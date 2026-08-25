import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const originalWorkingDirectory = process.cwd();

afterEach(() => {
	process.chdir(originalWorkingDirectory);
});

describe("static plugin-definition import baseline", () => {
	it("does not mutate process or filesystem state", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "localhost2137-import-"));
		const environmentBeforeImport = { ...process.env };
		const signalListenersBeforeImport = {
			SIGINT: process.listenerCount("SIGINT"),
			SIGTERM: process.listenerCount("SIGTERM"),
		};

		try {
			process.chdir(workingDirectory);
			const { samplePlugin } = await import("./fixtures/plugin-under-import.js");

			expect(typeof samplePlugin).toBe("function");
			expect(process.env).toEqual(environmentBeforeImport);
			expect(process.listenerCount("SIGINT")).toBe(signalListenersBeforeImport.SIGINT);
			expect(process.listenerCount("SIGTERM")).toBe(signalListenersBeforeImport.SIGTERM);
			expect(await readdir(workingDirectory)).toEqual([]);
		} finally {
			process.chdir(originalWorkingDirectory);
			await rm(workingDirectory, { force: true, recursive: true });
		}
	});
});
