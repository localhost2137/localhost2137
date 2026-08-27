import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureConfig = join(
	packageDirectory,
	"test/fixtures/config-project/cli-process/localhost.config.ts",
);
const sourceBin = join(packageDirectory, "src/bin.ts");
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const temporaryDirectories: string[] = [];
const runningChildren: ChildProcess[] = [];

afterEach(async () => {
	await Promise.all(
		runningChildren.splice(0).map(async (child) => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
			await processExit(child).catch(() => undefined);
		}),
	);
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("localhost process transcript", () => {
	it("initializes an empty project without config discovery or a daemon", async () => {
		const project = await temporaryProject("init");
		temporaryDirectories.push(project);

		const first = command(project, ["init"]);
		expect(first.status, first.stderr).toBe(0);
		expect(first.stderr).toBe("");
		expect(first.stdout).toContain("Created localhost.config.ts");
		expect(first.stdout).toContain("pnpm exec localhost dev");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toContain(
			"defineConfig",
		);
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(".localhost2137/\n");

		const second = command(project, ["init"]);
		expect(second.status).toBe(2);
		expect(second.stdout).toBe("");
		expect(second.stderr).toContain("Refusing to replace existing localhost2137 config");
	}, 30_000);

	it("uses one explicit, non-discoverable config for the complete CLI session", async () => {
		const project = await temporaryProject("config");
		temporaryDirectories.push(project);
		const configPath = join(project, "custom.localhost.ts");
		await copyFile(fixtureConfig, configPath);
		const port = await availablePort();
		const run = (arguments_: readonly string[]) => command(project, arguments_);
		const runJson = (arguments_: readonly string[]) => jsonCommand(project, arguments_);

		const dev = spawn(
			process.execPath,
			[tsxCli, sourceBin, "--config", configPath, "dev", "--port", String(port)],
			processOptions(project),
		);
		runningChildren.push(dev);
		await waitForReady(dev);

		expect(
			runJson([
				"exec",
				"fixture",
				"echo",
				"--message",
				"custom",
				"--json",
				`--config=${configPath}`,
			]),
		).toEqual({ message: "custom" });
		expect(runJson(["doctor", "--config", configPath, "--json"])).toMatchObject({
			runtime: { state: "healthy", url: `http://127.0.0.1:${port}` },
			status: "ok",
		});
		expect(runJson(["--config", configPath, "env", "--format", "json"])).toEqual({
			FIXTURE_TOKEN: "fixture-secret-value",
			FIXTURE_URL: `http://127.0.0.1:${port}/dev/fixture`,
		});

		const child = run([
			"--config",
			configPath,
			"run",
			"--",
			process.execPath,
			"-e",
			'if (JSON.stringify(process.argv.slice(1)) !== JSON.stringify(["--config", "child.ts"])) process.exit(23)',
			"--",
			"--config",
			"child.ts",
		]);
		expect(child.status).toBe(0);

		const delimiter = run([
			"--config",
			configPath,
			"exec",
			"fixture",
			"echo",
			"--",
			"--instance",
			"nope",
		]);
		expect(delimiter.status).toBe(2);
		expect(delimiter.stderr).not.toContain('no instance "nope"');

		dev.kill("SIGINT");
		expect(await processExit(dev)).toEqual({ code: 130, signal: null });
	}, 30_000);

	it("executes the non-Slack v0.1 command surface against one real daemon", async () => {
		const project = await temporaryProject("process");
		temporaryDirectories.push(project);
		await copyFile(fixtureConfig, join(project, "localhost.config.ts"));
		const port = await availablePort();
		const run = (
			arguments_: readonly string[],
			environment: Readonly<Record<string, string>> = {},
		) => command(project, arguments_, environment);
		const runJson = (
			arguments_: readonly string[],
			environment: Readonly<Record<string, string>> = {},
		) => jsonCommand(project, arguments_, environment);

		const dev = spawn(
			process.execPath,
			[tsxCli, sourceBin, "dev", "--port", String(port)],
			processOptions(project),
		);
		runningChildren.push(dev);
		const ready = await waitForReady(dev);
		const storage = join(project, ".localhost2137");
		const controlToken = (await readFile(join(storage, "control-token"), "utf8")).trim();

		expect(ready.stderr).toContain(`runtime: http://127.0.0.1:${port}`);
		expect(ready.stderr).toContain("variables: FIXTURE_TOKEN, FIXTURE_URL");
		expect(ready.stderr).not.toContain("fixture-secret-value");
		expect(ready.stderr).not.toContain(controlToken);
		expect(await readFile(join(storage, ".env"), "utf8")).not.toContain(controlToken);

		const services = runJson(["describe", "--json"]);
		expect(services).toEqual([expect.objectContaining({ name: "fixture" })]);
		const description = runJson(["describe", "fixture", "--json"]);
		expect(description).toMatchObject({
			name: "fixture",
			operations: {
				echo: {
					description: "Echo a message",
					input: { type: "object" },
				},
			},
		});
		expect(
			runJson(["exec", "fixture", "echo", "--message", "ping", "--count", "2", "--json"]),
		).toEqual({ message: "pingping" });
		const unknownOperation = run(["exec", "fixture", "missing-operation"]);
		expect(unknownOperation.status).toBe(4);
		expect(unknownOperation.stdout).toBe("");
		expect(unknownOperation.stderr).toContain("unknown command 'missing-operation'");
		const malformedOperation = run([
			"exec",
			"fixture",
			"echo",
			"--message",
			"ok",
			"--unknown-flag",
		]);
		expect(malformedOperation.status).toBe(2);
		expect(malformedOperation.stdout).toBe("");
		expect(malformedOperation.stderr).toContain("unknown option '--unknown-flag'");

		expect(run(["instance", "create", "review"]).stdout).toBe("created review\n");
		expect(runJson(["instance", "list", "--json"])).toEqual([
			expect.objectContaining({ id: "dev" }),
			expect.objectContaining({ id: "review" }),
		]);
		expect(runJson(["env", "--instance", "review", "--format", "json"])).toEqual({
			FIXTURE_TOKEN: "fixture-secret-value",
			FIXTURE_URL: `http://127.0.0.1:${port}/review/fixture`,
		});
		const child = run([
			"run",
			"--instance",
			"review",
			"--",
			process.execPath,
			"-e",
			`if (process.env.FIXTURE_URL !== ${JSON.stringify(`http://127.0.0.1:${port}/review/fixture`)} || process.env.FIXTURE_TOKEN !== "fixture-secret-value" || process.env.LOCALHOST_CONTROL_TOKEN) process.exit(19)`,
		]);
		expect(child.status).toBe(0);
		expect(runJson(["logs", "fixture", "--instance", "review", "--json"])).toEqual(
			expect.objectContaining({ entries: expect.any(Array) }),
		);
		expect(runJson(["clock", "status", "--instance", "review", "--json"])).toEqual(
			expect.objectContaining({ mode: "real", now: expect.any(String) }),
		);
		expect(runJson(["doctor", "--json"])).toMatchObject({
			runtime: { state: "healthy", url: `http://127.0.0.1:${port}` },
			status: "ok",
		});

		expect(run(["seed", "--instance", "review"]).stdout).toBe("seeded review\n");
		expect(run(["instance", "reset", "review"]).stdout).toBe("reset review\n");
		const defaultInstance = runJson(["exec", "fixture", "echo", "--message", "scoped", "--json"], {
			LOCALHOST_INSTANCE: "review",
		});
		expect(defaultInstance).toEqual({ message: "scoped" });

		const missing = run(["exec", "fixture", "echo", "--instance", "nope", "--message", "x"]);
		expect(missing.status).toBe(4);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toContain('no instance "nope" (existing: dev, review)');
		expect(missing.stderr).toContain("hint: localhost instance create nope");
		expect(missing.stderr).not.toContain("correlation");

		expect(run(["instance", "destroy", "review"]).stdout).toBe("destroyed review\n");
		dev.kill("SIGINT");
		const stopped = await processExit(dev);
		expect(stopped).toEqual({ code: 130, signal: null });
		expect(await pathExists(join(storage, "runtime.json"))).toBe(false);
		expect(await pathExists(join(storage, "control-token"))).toBe(false);
		expect(await pathExists(join(storage, "lock"))).toBe(false);
		expect(await pathExists(join(storage, "instances", "dev", "instance.json"))).toBe(true);
	}, 30_000);
});

function command(
	cwd: string,
	arguments_: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): Readonly<{ status: number | null; stderr: string; stdout: string }> {
	const result = spawnSync(process.execPath, [tsxCli, sourceBin, ...arguments_], {
		...processOptions(cwd),
		env: { ...process.env, ...environment },
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return Object.freeze({
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	});
}

function jsonCommand(
	cwd: string,
	arguments_: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): unknown {
	const result = command(cwd, arguments_, environment);
	if (result.status !== 0) {
		throw new Error(
			`Command ${arguments_.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
		);
	}
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout);
}

function processOptions(cwd: string) {
	return {
		cwd,
		env: { ...process.env, LOCALHOST_INSTANCE: "" },
		stdio: ["ignore", "pipe", "pipe"] as const,
	};
}

async function temporaryProject(label: string): Promise<string> {
	const cache = join(packageDirectory, "test/.tmp");
	await mkdir(cache, { recursive: true });
	return mkdtemp(join(cache, `localhost2137-cli-${label}-`));
}

async function waitForReady(
	child: ChildProcess,
): Promise<Readonly<{ stderr: string; stdout: string }>> {
	let stderr = "";
	let stdout = "";
	child.stderr?.setEncoding("utf8");
	child.stdout?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	await new Promise<void>((resolveReady, reject) => {
		const cleanup = () => {
			clearInterval(poll);
			clearTimeout(timeout);
			child.off("exit", exited);
		};
		const exited = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(new Error(`Dev exited before readiness (${code ?? signal}).\n${stderr}`));
		};
		const poll = setInterval(() => {
			if (!stderr.includes("localhost2137 ready")) return;
			cleanup();
			resolveReady();
		}, 10);
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for dev readiness.\n${stderr}`));
		}, 10_000);
		child.once("exit", exited);
	});
	return Object.freeze({ stderr, stdout });
}

function processExit(
	child: ChildProcess,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(Object.freeze({ code: child.exitCode, signal: child.signalCode }));
	}
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit(Object.freeze({ code, signal })));
	});
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => resolveListen());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected an assigned TCP port.");
	await new Promise<void>((resolveClose, reject) =>
		server.close((cause) => (cause ? reject(cause) : resolveClose())),
	);
	return address.port;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return false;
		throw cause;
	}
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
