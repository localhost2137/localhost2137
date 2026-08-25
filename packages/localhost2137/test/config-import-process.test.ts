import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("config import process compatibility", () => {
	it("loads TypeScript config without runtime deprecation output on supported Node", async () => {
		const project = await mkdtemp(join(tmpdir(), "localhost2137-config-process-"));
		try {
			await writeFile(join(project, "localhost.config.mts"), "export default { services: {} };\n");
			const configLoader = pathToFileURL(join(packageDirectory, "src/config/load-config.ts")).href;
			const script = `
import { loadResolvedConfig } from ${JSON.stringify(configLoader)};
await loadResolvedConfig({ cwd: ${JSON.stringify(project)} });
process.stdout.write("loaded\\n");
`;
			const result = spawnSync(
				process.execPath,
				["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
				{ cwd: packageDirectory, encoding: "utf8" },
			);

			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("loaded\n");
			expect(result.stderr).toBe("");
		} finally {
			await rm(project, { force: true, recursive: true });
		}
	});
});
