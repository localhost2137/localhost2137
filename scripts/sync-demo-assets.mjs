import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
	["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
	["src/bot.ts", "src/bot.ts"],
	["src/main.ts", "src/main.ts"],
	["test/ping-pong.test.ts", "test/ping-pong.test.ts"],
	["tsconfig.json", "tsconfig.json"],
	["vitest.config.ts", "vitest.config.ts"],
]);
const packageTargetName = "package.json";
const workspacePackages = Object.freeze(
	new Map([
		["@localhost2137/slack", join(repositoryRoot, "plugins/slack/package.json")],
		["localhost2137", join(repositoryRoot, "packages/localhost2137/package.json")],
	]),
);

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
	await writeFile(join(targetRoot, packageTargetName), await standalonePackageJson());
	process.stdout.write("Synchronized embedded demo assets.\n");
} else if (argument === undefined) {
	await checkAssets();
	process.stdout.write("Embedded demo assets match their canonical example.\n");
} else {
	throw new Error("Usage: node scripts/sync-demo-assets.mjs [--write]");
}

async function checkAssets() {
	const expectedNames = [...files.map(([, targetName]) => targetName), packageTargetName].sort();
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
	const expectedPackageJson = await standalonePackageJson();
	const targetPackageJson = await readFile(join(targetRoot, packageTargetName));
	if (!expectedPackageJson.equals(targetPackageJson)) {
		throw new Error("Embedded demo package.json is stale. Run pnpm demo-assets:sync.");
	}
}

async function standalonePackageJson() {
	const sourcePath = join(sourceRoot, "package.json");
	const manifest = await readJsonObject(sourcePath, "Demo package.json");
	const resolvedVersions = new Map();
	for (const [packageName, manifestPath] of workspacePackages) {
		const dependencyManifest = await readJsonObject(manifestPath, `${packageName} package.json`);
		if (typeof dependencyManifest.version !== "string" || dependencyManifest.version === "") {
			throw new Error(`${packageName} package.json must declare a version.`);
		}
		resolvedVersions.set(packageName, dependencyManifest.version);
	}

	const replaced = new Set();
	for (const sectionName of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const section = manifest[sectionName];
		if (section === undefined) continue;
		if (!isJsonObject(section)) throw new Error(`Demo ${sectionName} must be an object.`);
		for (const [dependencyName, specifier] of Object.entries(section)) {
			if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
			const version = resolvedVersions.get(dependencyName);
			if (specifier !== "workspace:*" || version === undefined) {
				throw new Error(
					`Unexpected workspace specifier ${dependencyName}@${specifier} in demo package.json.`,
				);
			}
			section[dependencyName] = version;
			replaced.add(dependencyName);
		}
	}
	for (const dependencyName of workspacePackages.keys()) {
		if (!replaced.has(dependencyName)) {
			throw new Error(`Demo package.json must declare ${dependencyName} as workspace:*.`);
		}
	}
	assertNoWorkspaceSpecifiers(manifest, "package.json");
	return Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readJsonObject(path, label) {
	let value;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (cause) {
		throw new Error(`${label} must contain valid JSON.`, { cause });
	}
	if (!isJsonObject(value)) throw new Error(`${label} must contain a JSON object.`);
	return value;
}

function assertNoWorkspaceSpecifiers(value, path) {
	if (typeof value === "string" && value.startsWith("workspace:")) {
		throw new Error(`Unexpected workspace specifier at ${path}: ${value}`);
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			assertNoWorkspaceSpecifiers(item, `${path}[${index}]`);
		}
	} else if (isJsonObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			assertNoWorkspaceSpecifiers(item, `${path}.${key}`);
		}
	}
}

function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
