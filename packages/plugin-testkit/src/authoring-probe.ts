import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceRecord } from "localhost2137";
import { capture, finishCaptured } from "./cleanup-owner.js";
import { assertContract, assertContractEqual, isPlainRecord } from "./contract-assertions.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";

const CASE_NAME = "authoring has no import or configuration side effects";
const CHILD_DEADLINE_MS = 5_000;

export function authoringCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): PluginContractCase {
	return Object.freeze({ name: CASE_NAME, run: () => runAuthoringProbe(fixture) });
}

async function runAuthoringProbe<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-contract-authoring-"));
	const outcome = await capture(async () => {
		const childSource = childModuleUrl();
		const args = [fileURLToPath(childSource)];
		if (childSource.pathname.endsWith(".ts")) args.unshift("--experimental-strip-types");
		args.push(fixture.authoring.module.href, fixture.authoring.exportName, fixture.serviceKey);
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		const messages: unknown[] = [];
		child.on("message", (message: unknown) => messages.push(message));
		const exit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve(Object.freeze({ code, signal })));
			},
		);
		let timeout: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`${CASE_NAME}: authoring child exceeded its bounded deadline`));
			}, CHILD_DEADLINE_MS);
		});
		try {
			const exited = await Promise.race([exit, deadline]);
			assertContract(
				exited.code === 0 && exited.signal === null,
				CASE_NAME,
				"authoring child failed",
			);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exit.catch(() => undefined);
		}
		assertContractEqual(Buffer.concat(stdout).toString("utf8"), "", CASE_NAME);
		assertContractEqual(Buffer.concat(stderr).toString("utf8"), "", CASE_NAME);
		assertContract(
			messages.length === 1,
			CASE_NAME,
			"authoring child sent an invalid IPC result count",
		);
		const result = messages[0];
		assertContract(isPlainRecord(result), CASE_NAME, "authoring child sent an invalid IPC result");
		if (!isPlainRecord(result)) return;
		assertContractEqual(result.exportValid, true, CASE_NAME);
		assertContractEqual(result.cwdChanged, false, CASE_NAME);
		assertContractEqual(result.environmentChanged, [], CASE_NAME);
		assertContractEqual(result.filesChanged, [], CASE_NAME);
		assertContractEqual(result.resourcesAdded, [], CASE_NAME);
	});
	const cleanupFailures: unknown[] = [];
	await rm(root, { force: true, recursive: true }).catch((cause: unknown) =>
		cleanupFailures.push(cause),
	);
	finishCaptured(outcome, cleanupFailures, "Authoring contract probe");
}

function childModuleUrl(): URL {
	const extension = extname(fileURLToPath(import.meta.url));
	return new URL(
		extension === ".ts" ? "./authoring-child.ts" : "./authoring-child.js",
		import.meta.url,
	);
}
