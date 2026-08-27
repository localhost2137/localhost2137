import { copyFile, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "examples/slack-ping-bot");
const targetRoot = join(repositoryRoot, "packages/localhost2137/demo-assets/v1/slack-ping-bot");
const files = Object.freeze([
	// npm always excludes nested .gitignore files from tarballs. The clone step
	// materializes this packaged template as .gitignore in the target project.
	[".gitignore", "gitignore.template"],
	["README.md", "README.md"],
	["localhost.config.ts", "localhost.config.ts"],
	["package.demo.json", "package.json"],
	["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
	["src/bot.ts", "src/bot.ts"],
	["src/main.ts", "src/main.ts"],
	["test/ping-pong.test.ts", "test/ping-pong.test.ts"],
	["tsconfig.json", "tsconfig.json"],
	["vitest.config.ts", "vitest.config.ts"],
]);

const [argument] = process.argv.slice(2);
if (argument === "--write") {
	await rm(targetRoot, { force: true, recursive: true });
	for (const [sourceName, targetName] of files) {
		const source = join(sourceRoot, sourceName);
		const target = join(targetRoot, targetName);
		await assertRegularFile(source, `Demo source ${sourceName}`);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
	process.stdout.write("Synchronized embedded demo assets.\n");
} else if (argument === undefined) {
	await checkAssets();
	process.stdout.write("Embedded demo assets match their canonical example.\n");
} else {
	throw new Error("Usage: node scripts/sync-demo-assets.mjs [--write]");
}

async function checkAssets() {
	const expectedNames = files.map(([, targetName]) => targetName).sort();
	const actualNames = await listRegularFiles(targetRoot);
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error(
			`Embedded demo inventory differs. Expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}. Run pnpm demo-assets:sync.`,
		);
	}
	for (const [sourceName, targetName] of files) {
		const source = join(sourceRoot, sourceName);
		const target = join(targetRoot, targetName);
		await assertRegularFile(source, `Demo source ${sourceName}`);
		await assertRegularFile(target, `Embedded demo ${targetName}`);
		if (!(await readFile(source)).equals(await readFile(target))) {
			throw new Error(`Embedded demo ${targetName} is stale. Run pnpm demo-assets:sync.`);
		}
	}
}

async function listRegularFiles(root) {
	const result = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Embedded demo contains a symlink: ${path}`);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile()) {
				result.push(relative(root, path).split(sep).join("/"));
			} else {
				throw new Error(`Embedded demo contains a non-regular entry: ${path}`);
			}
		}
	}
	await visit(root);
	return result.sort();
}

async function assertRegularFile(path, label) {
	const metadata = await lstat(path);
	if (!metadata.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}
