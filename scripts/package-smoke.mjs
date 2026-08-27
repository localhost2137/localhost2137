import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const placeholderPackageBins = Object.freeze(
	new Map([
		["create-localhost2137", "create-localhost2137"],
		["create-localhost2137-plugin", "create-localhost2137-plugin"],
	]),
);

function runPnpm(
	arguments_,
	workingDirectory = repositoryRoot,
	stdio = "inherit",
	environment,
) {
	const result = spawnSync(pnpmExecutable, arguments_, {
		cwd: workingDirectory,
		...(environment === undefined ? {} : { env: environment }),
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

function cleanRoomPnpmEnvironment() {
	const environment = { ...process.env };
	for (const name of Object.keys(environment)) {
		const normalizedName = name.toLowerCase();
		if (
			name.startsWith("npm_package_") ||
			name.startsWith("npm_lifecycle_") ||
			name === "INIT_CWD" ||
			normalizedName === "npm_command" ||
			normalizedName === "npm_config_filter" ||
			normalizedName === "npm_config_recursive" ||
			normalizedName.startsWith("npm_config_workspace") ||
			name === "PNPM_PACKAGE_NAME" ||
			name === "PNPM_SCRIPT_SRC_DIR" ||
			name === "PNPM_WORKSPACE_DIR"
		) {
			delete environment[name];
		}
	}
	return environment;
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
		(entry) => resolve(entry.path) !== repositoryRoot && isPackagedWorkspace(resolve(entry.path)),
	);
	const packages = await Promise.all(
		workspaceEntries.map(async (entry) => ({
			directory: resolve(entry.path),
			manifest: await readJson(join(entry.path, "package.json")),
		})),
	);

	return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function isPackagedWorkspace(directory) {
	const [group] = relative(repositoryRoot, directory).split(sep);
	return group === "packages" || group === "plugins";
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

async function assertMissing(path, message) {
	try {
		await readFile(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}

	throw new Error(message);
}

function assertRegistrySafeDemoManifest(manifest) {
	for (const sectionName of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const section = manifest[sectionName];
		if (section === undefined) continue;
		if (typeof section !== "object" || section === null || Array.isArray(section)) {
			throw new Error(`Embedded demo ${sectionName} must be an object`);
		}
		for (const [name, specifier] of Object.entries(section)) {
			if (typeof specifier !== "string" || /^(?:file|link|workspace):/.test(specifier)) {
				throw new Error(
					`Embedded demo dependency ${name} must use a public npm specifier; found ${String(specifier)}`,
				);
			}
		}
	}
}

function assertTarballDependencies({
	environment,
	label,
	packageDependencies,
	packageNames,
	workingDirectory,
}) {
	const installedResult = runPnpm(
		["list", "--depth", "0", "--json"],
		workingDirectory,
		["ignore", "pipe", "inherit"],
		environment,
	);
	const [installedProject] = JSON.parse(installedResult.stdout.toString());
	for (const packageName of packageNames) {
		const installed =
			installedProject?.dependencies?.[packageName] ??
			installedProject?.devDependencies?.[packageName];
		const expectedTarball = resolveFileDependency(
			packageDependencies[packageName],
			workingDirectory,
		);
		const installedTarball = resolveFileDependency(installed?.resolved, workingDirectory);
		if (!expectedTarball || installedTarball !== expectedTarball) {
			throw new Error(`${label} ${packageName} did not resolve from its generated tarball`);
		}
	}
}

async function assertPlaceholderPackages(consumerDirectory, availablePackages) {
	for (const [packageName, binName] of placeholderPackageBins) {
		if (!availablePackages.has(packageName)) continue;
		const manifest = await readJson(
			join(consumerDirectory, "node_modules", packageName, "package.json"),
		);
		if (manifest.bin?.[binName] !== "./bin.js") {
			throw new Error(`Packed ${packageName} does not declare bin.${binName}`);
		}
		const result = runPnpm(["exec", binName], consumerDirectory, ["ignore", "pipe", "pipe"]);
		if (result.stdout.toString() !== "To be implemented\n" || result.stderr.length !== 0) {
			throw new Error(`Packed ${packageName} did not print its exact placeholder output`);
		}
	}
}

async function preparePackedDemoFixture({ consumerDirectory, packageDependencies }) {
	const hostPackageDirectory = join(consumerDirectory, "node_modules/localhost2137");
	const embeddedManifestPath = join(
		hostPackageDirectory,
		"demo-assets/v1/slack-ping-bot/package.json",
	);
	const shippedManifest = await readJson(embeddedManifestPath);
	assertRegistrySafeDemoManifest(shippedManifest);
	const packedPackages = [
		{
			manifest: await readJson(join(hostPackageDirectory, "package.json")),
			name: "localhost2137",
		},
		{
			manifest: await readJson(
				join(consumerDirectory, "node_modules/@localhost2137/slack/package.json"),
			),
			name: "@localhost2137/slack",
		},
	];

	for (const { manifest, name } of packedPackages) {
		const shippedSpecifier = shippedManifest.devDependencies?.[name];
		if (shippedSpecifier !== manifest.version) {
			throw new Error(
				`Embedded demo must declare the packed ${name} version exactly; found ${String(shippedSpecifier)}`,
			);
		}
		if (!packageDependencies[name]) {
			throw new Error(`Package smoke did not pack the demo dependency ${name}`);
		}
	}

	const fixtureManifest = structuredClone(shippedManifest);
	for (const { name } of packedPackages) {
		fixtureManifest.devDependencies[name] = packageDependencies[name];
	}

	// Replace only the disposable consumer's virtual-store entry. An atomic rename avoids
	// mutating a hard-linked pnpm store file or changing the manifest inside the tarball.
	const fixtureManifestPath = `${embeddedManifestPath}.package-smoke-${process.pid}`;
	await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`, {
		flag: "wx",
	});
	await rename(fixtureManifestPath, embeddedManifestPath);

	return { fixtureManifest, packageNames: packedPackages.map(({ name }) => name) };
}

function runPackedDemoClone({ cloneParentDirectory, installedBinPath }) {
	const cloneResult = spawnSync(
		process.execPath,
		[installedBinPath, "demo", "clone", "slack-ping-bot"],
		{
			cwd: cloneParentDirectory,
			encoding: "utf8",
			env: cleanRoomPnpmEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (cloneResult.error) {
		throw cloneResult.error;
	}
	if (cloneResult.status !== 0) {
		const detail = cloneResult.signal
			? `signal ${cloneResult.signal}`
			: `exit code ${cloneResult.status}`;
		throw new Error(
			`Packed localhost demo clone failed with ${detail}\n${cloneResult.stdout}${cloneResult.stderr}`,
		);
	}
	if (
		!cloneResult.stdout.includes("Cloned slack-ping-bot to ./slack-ping-bot") ||
		!cloneResult.stdout.includes("Installed dependencies with pnpm.")
	) {
		throw new Error("Packed localhost demo clone did not report clone and install completion");
	}
}

async function verifyClonedDemo({
	demoDirectory,
	environment,
	fixtureManifest,
	packageDependencies,
	packageNames,
}) {
	const clonedManifest = await readJson(join(demoDirectory, "package.json"));
	if (JSON.stringify(clonedManifest) !== JSON.stringify(fixtureManifest)) {
		throw new Error("Cloned demo manifest differs from the embedded package fixture");
	}
	await readFile(join(demoDirectory, ".gitignore"), "utf8");
	await assertMissing(
		join(demoDirectory, "gitignore.template"),
		"Cloned demo retained its internal gitignore template name",
	);

	assertTarballDependencies({
		environment,
		label: "Cloned demo dependency",
		packageDependencies,
		packageNames,
		workingDirectory: demoDirectory,
	});
}

async function assertNoDemoCloneOwnershipEntries(cloneParentDirectory) {
	const leftovers = (await readdir(cloneParentDirectory)).filter((entry) =>
		entry.startsWith(".localhost2137.demo-clone-"),
	);
	if (leftovers.length > 0) {
		throw new Error(`Demo clone left temporary ownership entries: ${leftovers.join(", ")}`);
	}
}

async function smokePackedDemoClone({
	cloneParentDirectory,
	consumerDirectory,
	installedBinPath,
	packageDependencies,
}) {
	const { fixtureManifest, packageNames } = await preparePackedDemoFixture({
		consumerDirectory,
		packageDependencies,
	});
	await assertMissing(
		join(cloneParentDirectory, "pnpm-workspace.yaml"),
		"Packed demo clean-room parent unexpectedly contained a pnpm workspace",
	);
	runPackedDemoClone({ cloneParentDirectory, installedBinPath });

	const demoDirectory = join(cloneParentDirectory, "slack-ping-bot");
	const cleanRoomEnvironment = cleanRoomPnpmEnvironment();
	await verifyClonedDemo({
		demoDirectory,
		environment: cleanRoomEnvironment,
		fixtureManifest,
		packageDependencies,
		packageNames,
	});
	await readFile(join(demoDirectory, "pnpm-lock.yaml"));
	const installedDirectory = await lstat(join(demoDirectory, "node_modules"));
	if (!installedDirectory.isDirectory()) {
		throw new Error("Packed demo install did not create a cwd-local node_modules directory");
	}
	runPnpm(["typecheck"], demoDirectory, "inherit", cleanRoomEnvironment);
	runPnpm(["test"], demoDirectory, "inherit", cleanRoomEnvironment);
	await assertNoDemoCloneOwnershipEntries(cloneParentDirectory);
}

async function main() {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "localhost2137-package-smoke-"));

	try {
		const tarballDirectory = join(temporaryRoot, "tarballs");
		const consumerDirectory = join(temporaryRoot, "consumer");
		const demoCloneDirectory = join(temporaryRoot, "demo-clone");
		const consumerStoreDirectory = join(temporaryRoot, "pnpm-store");
		await mkdir(tarballDirectory);
		await mkdir(consumerDirectory);
		await mkdir(demoCloneDirectory);
		await assertMissing(
			join(temporaryRoot, "pnpm-workspace.yaml"),
			"Package-smoke temporary root unexpectedly contained a pnpm workspace",
		);

		const rootManifest = await readJson(join(repositoryRoot, "package.json"));
		const workspacePackages = await discoverWorkspacePackages();
		if (workspacePackages.length === 0) {
			throw new Error("pnpm did not discover any non-root workspace packages");
		}
		const packageNames = workspacePackages.map(({ manifest }) => manifest.name);
		const importablePackageNames = workspacePackages
			.filter(({ manifest }) => {
				if (manifest.exports !== undefined) return true;
				if (placeholderPackageBins.has(manifest.name)) return false;
				throw new Error(
					`Packaged workspace ${manifest.name} has neither public exports nor a recognized CLI-only contract`,
				);
			})
			.map(({ manifest }) => manifest.name);
		const workspacePackageNames = new Set(packageNames);
		const packageDependencies = {};
		const peerDependencies = {};

		runPnpm(["build:clean"]);

		for (const workspacePackage of workspacePackages) {
			const tarballsBefore = new Set(await readdir(tarballDirectory));
			const packResult = runPnpm(
				[
					"--dir",
					workspacePackage.directory,
					"pack",
					"--pack-destination",
					tarballDirectory,
					"--json",
				],
				repositoryRoot,
				["ignore", "pipe", "inherit"],
			);
			const packInventory = JSON.parse(packResult.stdout.toString());
			if (!Array.isArray(packInventory.files)) {
				throw new Error(
					`pnpm did not return a file inventory for ${workspacePackage.manifest.name}`,
				);
			}
			if (
				workspacePackage.manifest.name === "localhost2137" &&
				packInventory.files.some(
					(file) =>
						file.path === "dist/kernel/time-advance.js" ||
						file.path === "dist/kernel/time-advance.d.ts" ||
						file.path.startsWith("dist/test-cache/") ||
						file.path.startsWith("test/.tmp/"),
				)
			) {
				throw new Error("Packed localhost2137 tarball retained removed or test-only output");
			}

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

		const imports = importablePackageNames.map(
			(name, index) => `import * as package${index} from ${JSON.stringify(name)};`,
		);
		const bindings = importablePackageNames.map((_, index) => `package${index}`).join(", ");
		if (!packageNames.includes("localhost2137")) {
			throw new Error("Package smoke requires the localhost2137 host package");
		}
		const runtimeAuthoringSmoke = `
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { Hono } from "hono";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineOperation, definePlugin } from "localhost2137";
import { connectRuntime } from "localhost2137/client";
import { createTestRuntime } from "localhost2137/testing";
import { createPluginContractCases } from "@localhost2137/plugin-testkit";
import { slack } from "@localhost2137/slack";
import { createStripeSdkFetch, stripe } from "@localhost2137/stripe";
import { z } from "zod";

if (typeof connectRuntime !== "function" || typeof createTestRuntime !== "function") {
	throw new Error("Packed localhost2137 testing entry points are incomplete");
}
if (typeof createPluginContractCases !== "function") {
	throw new Error("Packed plugin testkit entry point is incomplete");
}
if (typeof slack !== "function") {
	throw new Error("Packed Slack plugin entry point is incomplete");
}
if (typeof stripe !== "function" || typeof createStripeSdkFetch !== "function") {
	throw new Error("Packed Stripe plugin entry point is incomplete");
}
const testkitEntryPath = fileURLToPath(import.meta.resolve("@localhost2137/plugin-testkit"));
const testkitSupervisorPath = join(dirname(testkitEntryPath), "durability-supervisor.js");
if (!readFileSync(testkitSupervisorPath, "utf8").includes("plugin-testkit:shutdown:v1")) {
	throw new Error("Packed plugin testkit durability supervisor is missing");
}

const hostManifestPath = fileURLToPath(import.meta.resolve("localhost2137/package.json"));
const hostPackageRoot = dirname(hostManifestPath);
const hostManifest = JSON.parse(readFileSync(hostManifestPath, "utf8"));
const hostBinTarget = hostManifest.bin?.localhost;
if (typeof hostBinTarget !== "string" || isAbsolute(hostBinTarget)) {
	throw new Error("Packed localhost2137 manifest has no relative bin.localhost");
}
const hostBinPath = resolve(hostPackageRoot, hostBinTarget);
const hostBinRelative = relative(hostPackageRoot, hostBinPath);
if (
	hostBinRelative === "" ||
	hostBinRelative === ".." ||
	hostBinRelative.startsWith(\`..\${sep}\`) ||
	isAbsolute(hostBinRelative)
) {
	throw new Error("Packed localhost2137 bin.localhost escapes its package root");
}
const realHostRoot = realpathSync(hostPackageRoot);
const realHostBin = realpathSync(hostBinPath);
const realBinRelative = relative(realHostRoot, realHostBin);
if (
	realBinRelative === "" ||
	realBinRelative === ".." ||
	realBinRelative.startsWith(\`..\${sep}\`) ||
	isAbsolute(realBinRelative)
) {
	throw new Error("Packed localhost2137 bin.localhost escapes through a resolved path");
}
const hostBinHelp = spawnSync(process.execPath, [realHostBin, "--help"], {
	encoding: "utf8",
});
if (hostBinHelp.status !== 0 || !hostBinHelp.stdout.includes("Usage: localhost")) {
	throw new Error("Packed localhost2137 binary was not directly executable with Node");
}

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

const packedSlackRuntime = await createTestRuntime({
	config: {
		services: {
			slack: slack({
				config: {
					botToken: "xoxb-packed-smoke",
					eventsUrl: null,
					signingSecret: "packed-smoke-secret",
					workspaceName: "Packed Smoke",
				},
			}),
		},
	},
	port: 0,
	storage: "temporary",
});
const packedSlackInstance = await packedSlackRuntime.createInstance();
try {
	const packedUser = await packedSlackInstance.slack.createUser({ name: "Packed Ada" });
	if (packedUser.id !== "U000001") {
		throw new Error("Packed Slack native persistence did not execute");
	}
} finally {
	await packedSlackInstance.destroy();
	await packedSlackRuntime.close();
}

const packedStripeRuntime = await createTestRuntime({
	config: {
		clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
		services: {
			stripe: stripe({
				config: {
					secretKey: "sk_test_packed_smoke",
					webhookSecret: "whsec_packed_smoke",
					webhookUrl: null,
				},
			}),
		},
	},
	port: 0,
	storage: "temporary",
});
const packedStripeInstance = await packedStripeRuntime.createInstance();
try {
	let adapterRequest;
	const packedStripeFetch = createStripeSdkFetch(
		packedStripeInstance.stripe.connection.apiUrl,
		async (input, init) => {
			const request = new Request(input, init);
			adapterRequest = {
				authorization: request.headers.get("authorization"),
				body: await request.text(),
				contentType: request.headers.get("content-type"),
				method: request.method,
				url: request.url,
			};
			return new Response(null, { status: 204 });
		},
	);
	const adapterResponse = await packedStripeFetch(
		new Request("https://api.stripe.com/v1/customers?limit=2", {
			body: "name=Packed+Adapter",
			headers: {
				authorization: "Bearer sk_test_packed_smoke",
				"content-type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		}),
	);
	if (
		adapterResponse.status !== 204 ||
		adapterRequest?.url !==
			packedStripeInstance.stripe.connection.apiUrl + "/v1/customers?limit=2" ||
		adapterRequest.method !== "POST" ||
		adapterRequest.authorization !== "Bearer sk_test_packed_smoke" ||
		adapterRequest.contentType !== "application/x-www-form-urlencoded" ||
		adapterRequest.body !== "name=Packed+Adapter"
	) {
		throw new Error("Packed Stripe SDK adapter did not preserve request semantics");
	}
	const customer = await packedStripeInstance.stripe.createCustomer({ name: "Packed Ada" });
	const product = await packedStripeInstance.stripe.createProduct({ name: "Packed Pro" });
	const price = await packedStripeInstance.stripe.createPrice({
		productId: product.id,
		unitAmount: 2500,
	});
	const subscription = await packedStripeInstance.stripe.createSubscription({
		customerId: customer.id,
		priceId: price.id,
	});
	await packedStripeInstance.clock.advance("30d");
	const invoices = await packedStripeInstance.stripe.listInvoices({
		subscriptionId: subscription.id,
	});
	if (
		customer.id !== "cus_000001" ||
		product.id !== "prod_000001" ||
		price.id !== "price_000001" ||
		subscription.id !== "sub_000001" ||
		invoices.length !== 2 ||
		invoices[1]?.id !== "in_000002"
	) {
		throw new Error("Packed Stripe native billing persistence did not execute");
	}
} finally {
	await packedStripeInstance.destroy();
	await packedStripeRuntime.close();
}
`;
		const typedAuthoringSmoke = `
import { Hono } from "hono";
import {
	defineOperation,
	definePlugin,
	type PluginEnv,
	type ServiceRecord,
} from "localhost2137";
import type { RuntimeClient } from "localhost2137/client";
import type { TestRuntime } from "localhost2137/testing";
import type { PluginContractFixture } from "@localhost2137/plugin-testkit";
import { z } from "zod";

type PackedRuntimeClient = RuntimeClient;
type PackedTestRuntime = TestRuntime<ServiceRecord>;
type PackedContractFixture = PluginContractFixture<ServiceRecord>;
declare const runtimeClient: PackedRuntimeClient;
declare const testRuntime: PackedTestRuntime;
declare const contractFixture: PackedContractFixture;
void runtimeClient;
void testRuntime;
void contractFixture;

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
			join(consumerDirectory, "pnpm-workspace.yaml"),
			'packages:\n  - "."\n\nallowBuilds:\n  better-sqlite3: true\n  esbuild: true\n',
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

		runPnpm(["install", "--store-dir", consumerStoreDirectory], consumerDirectory);
		assertTarballDependencies({
			label: "Installed workspace package",
			packageDependencies,
			packageNames,
			workingDirectory: consumerDirectory,
		});
		await assertPlaceholderPackages(consumerDirectory, workspacePackageNames);
		const installedHostManifest = await readJson(
			join(consumerDirectory, "node_modules/localhost2137/package.json"),
		);
		if (installedHostManifest.bin?.localhost !== "./dist/bin.js") {
			throw new Error("Packed localhost2137 package does not declare the localhost binary");
		}
		for (const subpath of [".", "./client", "./testing", "./package.json"]) {
			if (!installedHostManifest.exports?.[subpath]) {
				throw new Error(`Packed localhost2137 package is missing export ${subpath}`);
			}
		}
		const installedTestkitManifest = await readJson(
			join(consumerDirectory, "node_modules/@localhost2137/plugin-testkit/package.json"),
		);
		if (!installedTestkitManifest.exports?.["."]) {
			throw new Error("Packed plugin testkit is missing its public entry point");
		}
		const installedBinPath = join(consumerDirectory, "node_modules/localhost2137/dist/bin.js");
		const installedBin = await readFile(installedBinPath, "utf8");
		if (!installedBin.startsWith("#!/usr/bin/env node\n")) {
			throw new Error("Packed localhost binary is missing its Node shebang");
		}
		const binaryHelp = runPnpm(["exec", "localhost", "--help"], consumerDirectory, [
			"ignore",
			"pipe",
			"pipe",
		]);
		if (!binaryHelp.stdout.toString().includes("Usage: localhost")) {
			throw new Error("Installed localhost binary did not render CLI help");
		}
		await smokePackedDemoClone({
			cloneParentDirectory: demoCloneDirectory,
			consumerDirectory,
			installedBinPath,
			packageDependencies,
		});
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
