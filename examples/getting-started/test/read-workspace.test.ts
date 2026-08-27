import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

const execFileAsync = promisify(execFile);

it("reads one seeded world through the provider-shaped HTTP API", async () => {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });

	try {
		const instance = await runtime.createInstance({ seed: true });
		try {
			const appPath = fileURLToPath(new URL("../src/read-workspace.ts", import.meta.url));
			const { stderr, stdout } = await execFileAsync(process.execPath, [appPath], {
				env: { ...process.env, ...instance.env },
			});

			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual([
				{ id: "U000000", name: "localhost2137-bot" },
				{ id: "U_ADA", name: "Ada" },
			]);
		} finally {
			await instance.destroy();
		}
	} finally {
		await runtime.close();
	}
});
