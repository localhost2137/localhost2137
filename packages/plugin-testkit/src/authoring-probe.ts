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
const CHILD_STOP_DEADLINE_MS = 2_000;
const OUTPUT_SAMPLE_BYTES = 256;

type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

type ChildRaceResult =
	| Readonly<{ exit: ChildExit; kind: "exit" }>
	| Readonly<{ kind: "output"; stream: "stderr" | "stdout" }>
	| Readonly<{ kind: "timeout" }>;

interface CappedChildOutput {
	readonly byteCount: number;
	readonly sample: Buffer;
	observe(chunk: Buffer): void;
}

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
		const messages: unknown[] = [];
		child.on("message", (message: unknown) => messages.push(message));
		const exit = new Promise<ChildExit>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve(Object.freeze({ code, signal })));
		});
		let reportOutput: (result: ChildRaceResult) => void = () => undefined;
		const output = new Promise<ChildRaceResult>((resolve) => {
			reportOutput = resolve;
		});
		let outputReported = false;
		const observeOutput =
			(stream: "stderr" | "stdout", state: CappedChildOutput) =>
			(chunk: Buffer): void => {
				state.observe(chunk);
				if (outputReported) return;
				outputReported = true;
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				reportOutput(Object.freeze({ kind: "output", stream }));
			};
		const stdout = cappedChildOutput();
		const stderr = cappedChildOutput();
		child.stdout?.on("data", observeOutput("stdout", stdout));
		child.stderr?.on("data", observeOutput("stderr", stderr));
		let timeout: NodeJS.Timeout | undefined;
		const deadline = new Promise<ChildRaceResult>((resolve) => {
			timeout = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				resolve(Object.freeze({ kind: "timeout" }));
			}, CHILD_DEADLINE_MS);
		});
		let result: ChildRaceResult;
		try {
			result = await Promise.race([
				exit.then((value): ChildRaceResult => Object.freeze({ exit: value, kind: "exit" })),
				output,
				deadline,
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await waitForChildStop(exit);
		}
		if (result.kind === "output") {
			const observed = result.stream === "stdout" ? stdout : stderr;
			assertContract(
				false,
				CASE_NAME,
				`authoring child ${result.stream} emitted output (${observed.byteCount} bytes observed)`,
			);
		}
		assertContract(
			result.kind !== "timeout",
			CASE_NAME,
			"authoring child exceeded its bounded deadline",
		);
		if (result.kind !== "exit") return;
		assertContract(
			result.exit.code === 0 && result.exit.signal === null,
			CASE_NAME,
			"authoring child failed",
		);
		assertContractEqual(stdout.byteCount, 0, CASE_NAME);
		assertContractEqual(stderr.byteCount, 0, CASE_NAME);
		assertContract(
			messages.length === 1,
			CASE_NAME,
			"authoring child sent an invalid IPC result count",
		);
		const message = messages[0];
		assertContract(isPlainRecord(message), CASE_NAME, "authoring child sent an invalid IPC result");
		if (!isPlainRecord(message)) return;
		assertContractEqual(message.exportValid, true, CASE_NAME);
		assertContractEqual(message.cwdChanged, false, CASE_NAME);
		assertContractEqual(message.environmentChanged, [], CASE_NAME);
		assertContractEqual(message.filesChanged, [], CASE_NAME);
		assertContractEqual(message.resourcesAdded, [], CASE_NAME);
	});
	const cleanupFailures: unknown[] = [];
	await rm(root, { force: true, recursive: true }).catch((cause: unknown) =>
		cleanupFailures.push(cause),
	);
	finishCaptured(outcome, cleanupFailures, "Authoring contract probe");
}

function cappedChildOutput(): CappedChildOutput {
	let byteCount = 0;
	let sample = Buffer.alloc(0);
	return {
		get byteCount() {
			return byteCount;
		},
		observe(chunk) {
			byteCount = Math.min(Number.MAX_SAFE_INTEGER, byteCount + chunk.byteLength);
			const remaining = OUTPUT_SAMPLE_BYTES - sample.byteLength;
			if (remaining <= 0) return;
			const selected = chunk.subarray(0, remaining);
			sample = Buffer.concat([sample, selected], sample.byteLength + selected.byteLength);
		},
		get sample() {
			return sample;
		},
	};
}

async function waitForChildStop(exit: Promise<ChildExit>): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`${CASE_NAME}: authoring child did not terminate after SIGKILL`)),
			CHILD_STOP_DEADLINE_MS,
		);
	});
	try {
		await Promise.race([exit, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function childModuleUrl(): URL {
	const extension = extname(fileURLToPath(import.meta.url));
	return new URL(
		extension === ".ts" ? "./authoring-child.ts" : "./authoring-child.js",
		import.meta.url,
	);
}
