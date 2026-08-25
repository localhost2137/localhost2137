import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runPnpm(arguments_, workingDirectory = repositoryRoot, stdio = "inherit") {
	const result = spawnSync(pnpmExecutable, arguments_, {
		cwd: workingDirectory,
		stdio,
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
		throw new Error(`pnpm ${arguments_.join(" ")} failed with ${detail}`);
	}

	return result;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function discoverWorkspacePackages() {
	const result = runPnpm(["list", "--recursive", "--depth", "-1", "--json"], repositoryRoot, [
		"ignore",
		"pipe",
		"inherit",
	]);
	const workspaceEntries = JSON.parse(result.stdout.toString()).filter(
		(entry) => resolve(entry.path) !== repositoryRoot,
	);
	const packages = await Promise.all(
		workspaceEntries.map(async (entry) => ({
			directory: resolve(entry.path),
			manifest: await readJson(join(entry.path, "package.json")),
		})),
	);

	return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function fileDependency(path) {
	return `file:${path.split(sep).join("/")}`;
}

function resolveFileDependency(specifier, workingDirectory) {
	if (typeof specifier !== "string" || !specifier.startsWith("file:")) {
		return undefined;
	}

	return resolve(workingDirectory, specifier.slice("file:".length));
}

async function main() {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "localhost2137-package-smoke-"));

	try {
		const tarballDirectory = join(temporaryRoot, "tarballs");
		const consumerDirectory = join(temporaryRoot, "consumer");
		const consumerStoreDirectory = join(temporaryRoot, "pnpm-store");
		await mkdir(tarballDirectory);
		await mkdir(consumerDirectory);

		const rootManifest = await readJson(join(repositoryRoot, "package.json"));
		const workspacePackages = await discoverWorkspacePackages();
		if (workspacePackages.length === 0) {
			throw new Error("pnpm did not discover any non-root workspace packages");
		}
		const packageNames = workspacePackages.map(({ manifest }) => manifest.name);
		const workspacePackageNames = new Set(packageNames);
		const packageDependencies = {};
		const peerDependencies = {};

		runPnpm(["build"]);

		for (const workspacePackage of workspacePackages) {
			const tarballsBefore = new Set(await readdir(tarballDirectory));
			runPnpm([
				"--dir",
				workspacePackage.directory,
				"pack",
				"--pack-destination",
				tarballDirectory,
			]);

			const newTarballs = (await readdir(tarballDirectory)).filter(
				(file) => file.endsWith(".tgz") && !tarballsBefore.has(file),
			);
			if (newTarballs.length !== 1) {
				throw new Error(
					`Expected one tarball for ${workspacePackage.manifest.name}, found ${newTarballs.length}`,
				);
			}

			packageDependencies[workspacePackage.manifest.name] = fileDependency(
				join(tarballDirectory, newTarballs[0]),
			);

			for (const peerName of Object.keys(workspacePackage.manifest.peerDependencies ?? {})) {
				if (workspacePackageNames.has(peerName)) {
					continue;
				}

				const exactVersion =
					workspacePackage.manifest.devDependencies?.[peerName] ??
					rootManifest.devDependencies?.[peerName];
				if (!exactVersion) {
					throw new Error(
						`Package ${workspacePackage.manifest.name} has peer ${peerName} without an installed exact test version`,
					);
				}
				if (peerDependencies[peerName] && peerDependencies[peerName] !== exactVersion) {
					throw new Error(
						`Workspace packages require conflicting smoke versions for peer ${peerName}`,
					);
				}
				peerDependencies[peerName] = exactVersion;
			}
		}

		const consumerDependencies = { ...peerDependencies, ...packageDependencies };
		for (const packageName of packageNames) {
			if (consumerDependencies[packageName] !== packageDependencies[packageName]) {
				throw new Error(
					`Workspace tarball dependency ${packageName} was replaced by a peer fixture`,
				);
			}
		}

		const imports = packageNames.map(
			(name, index) => `import * as package${index} from ${JSON.stringify(name)};`,
		);
		const bindings = packageNames.map((_, index) => `package${index}`).join(", ");
		if (!packageNames.includes("localhost2137")) {
			throw new Error("Package smoke requires the localhost2137 host package");
		}
		const runtimeAuthoringSmoke = `
import { Hono } from "hono";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineOperation, definePlugin } from "localhost2137";
import { z } from "zod";

const bindPackedOperation = defineOperation();
const packedOperation = bindPackedOperation({
	description: "Verify packed peer identity",
	input: z.object({ name: z.string() }),
	output: z.object({ ok: z.boolean() }),
	run: () => ({ ok: true }),
});
const packedPlugin = definePlugin({
	api: new Hono(),
	configSchema: z.object({ token: z.string() }),
	connection: ({ config }) => ({ env: {}, values: { token: config.token } }),
	description: "Packed consumer fixture",
	id: "packed-consumer",
	lifecycle: {
		create: () => undefined,
		start: () => ({ ready: true }),
	},
	operations: { verifyPeer: packedOperation },
	stateVersion: 1,
});
const hostEntryPath = fileURLToPath(import.meta.resolve("localhost2137"));
const resolverUrl = pathToFileURL(
	join(dirname(hostEntryPath), "config/config-resolution.js"),
).href;
const { resolveConfig } = await import(resolverUrl);
const resolved = resolveConfig(
	{ services: { packed: packedPlugin({ config: { token: "fixture" } }) } },
	join(process.cwd(), "localhost.config.ts"),
);
if (resolved.services.packed.operations.verifyPeer.cli.kind !== "flags") {
	throw new Error("Packed consumer ZodObject did not retain host constructor identity");
}
`;
		const typedAuthoringSmoke = `
import { Hono } from "hono";
import {
	defineOperation,
	definePlugin,
	type PluginEnv,
} from "localhost2137";
import { z } from "zod";

type PackedConfig = { readonly token: string };
type PackedState = { readonly ready: true };
const bindPackedOperation = defineOperation<"packed-consumer", PackedState, PackedConfig>();
const packedOperation = bindPackedOperation({
	description: "Verify packed declarations",
	input: z.object({ name: z.string() }),
	output: z.object({ ok: z.boolean() }),
	run: () => ({ ok: true }),
});
const packedPlugin = definePlugin({
	api: new Hono<PluginEnv<PackedState, PackedConfig>>(),
	configSchema: z.object({ token: z.string() }),
	connection: ({ config }) => ({ env: {}, values: { token: config.token } }),
	description: "Packed declaration fixture",
	id: "packed-consumer",
	lifecycle: {
		create: () => undefined,
		start: (): PackedState => ({ ready: true }),
	},
	operations: { verifyPeer: packedOperation },
	stateVersion: 1,
});
void packedPlugin({ config: { token: "fixture" } });
`;

		await writeFile(
			join(consumerDirectory, "package.json"),
			`${JSON.stringify(
				{
					name: "localhost2137-package-smoke-consumer",
					private: true,
					type: "module",
					scripts: {
						smoke: "node smoke.mjs",
						typecheck: "tsc --project tsconfig.json --pretty false",
					},
					dependencies: consumerDependencies,
					devDependencies: { typescript: rootManifest.devDependencies.typescript },
				},
				null,
				2,
			)}\n`,
		);
		await writeFile(
			join(consumerDirectory, "smoke.mjs"),
			`${imports.join("\n")}\n${runtimeAuthoringSmoke}\nfor (const module of [${bindings}]) {\n\tif (typeof module !== "object") throw new Error("Package import did not return a module namespace");\n}\n`,
		);
		await writeFile(
			join(consumerDirectory, "consumer.ts"),
			`${imports.join("\n")}\n${typedAuthoringSmoke}\nconst modules: readonly object[] = [${bindings}];\nvoid modules;\n`,
		);
		await writeFile(
			join(consumerDirectory, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						lib: ["ES2024", "DOM", "DOM.Iterable"],
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						skipLibCheck: false,
						strict: true,
						target: "ES2024",
					},
					include: ["consumer.ts"],
				},
				null,
				2,
			)}\n`,
		);

		runPnpm(
			["install", "--store-dir", consumerStoreDirectory, "--ignore-scripts"],
			consumerDirectory,
		);
		const installedResult = runPnpm(["list", "--depth", "0", "--json"], consumerDirectory, [
			"ignore",
			"pipe",
			"inherit",
		]);
		const [installedConsumer] = JSON.parse(installedResult.stdout.toString());
		for (const packageName of packageNames) {
			const installed = installedConsumer?.dependencies?.[packageName];
			const expectedTarball = resolveFileDependency(
				packageDependencies[packageName],
				consumerDirectory,
			);
			const installedTarball = resolveFileDependency(installed?.resolved, consumerDirectory);
			if (!expectedTarball || installedTarball !== expectedTarball) {
				throw new Error(
					`Installed workspace package ${packageName} did not resolve from its generated tarball`,
				);
			}
		}
		runPnpm(["smoke"], consumerDirectory);
		runPnpm(["typecheck"], consumerDirectory);

		process.stdout.write(
			`Package smoke passed for ${packageNames.length} workspace tarballs with install provenance verified.\n`,
		);
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
		process.stdout.write(`Removed package-smoke temporary directory ${temporaryRoot}.\n`);
	}
}

await main();
