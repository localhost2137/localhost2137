import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = join(repositoryRoot, "packages/plugin-testkit/src/import-boundary-fixture.ts");
const eslint = new ESLint({ cwd: repositoryRoot, ignore: false });

async function restrictedImportMessages(source: string) {
	const [result] = await eslint.lintText(source, { filePath: fixturePath });
	return result?.messages.filter((message) => message.ruleId === "no-restricted-imports") ?? [];
}

describe("plugin test-kit import boundary", () => {
	it.each([
		'import type { Runtime } from "../../localhost2137/src/testing/index.js";',
		'import type { Runtime } from "localhost2137/control";',
	])("rejects runtime implementation import %s", async (source) => {
		expect(await restrictedImportMessages(source)).toHaveLength(1);
	});

	it.each([
		'import type { RuntimeConfig } from "localhost2137";',
		'import type { TestRuntime } from "localhost2137/testing";',
	])("allows public package import %s", async (source) => {
		expect(await restrictedImportMessages(source)).toEqual([]);
	});
});
