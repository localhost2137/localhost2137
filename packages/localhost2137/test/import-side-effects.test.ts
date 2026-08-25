import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const originalWorkingDirectory = process.cwd();

afterEach(() => {
	process.chdir(originalWorkingDirectory);
});

describe("sample plugin import", () => {
	it("only constructs inspectable definitions", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "localhost2137-import-"));
		const environmentBeforeImport = { ...process.env };
		const signalListenersBeforeImport = {
			SIGINT: process.listenerCount("SIGINT"),
			SIGTERM: process.listenerCount("SIGTERM"),
		};

		try {
			process.chdir(workingDirectory);
			const { samplePlugin } = await import("./fixtures/sample-plugin.js");

			expect(samplePlugin.id).toBe("sample");
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
