import { EventEmitter } from "node:events";
import { execPath } from "node:process";
import { describe, expect, it, vi } from "vitest";
import {
	type ChildCommandSignalSource,
	type ChildCommandSpawner,
	ChildCommandStartError,
	runChildCommand,
} from "../../src/node/child-command.js";

describe("child command adapter", () => {
	it("spawns argv directly, overlays only connection env, and inherits stdio", async () => {
		const child = fakeChild();
		const spawn = vi.fn<ChildCommandSpawner>(() => child.process);
		const running = runChildCommand(
			{
				argv: ["node", "-e", 'console.log("$HOME && literal")'],
				connectionEnv: { APP_URL: "http://127.0.0.1:2137/dev/app", SHARED: "connection" },
				cwd: "/project",
				inheritedEnv: { HOME: "/home/user", SHARED: "inherited" },
			},
			{ signals: signalSource().source, spawn },
		);
		child.close(0, null);

		await expect(running).resolves.toBe(0);
		expect(spawn).toHaveBeenCalledWith("node", ["-e", 'console.log("$HOME && literal")'], {
			cwd: "/project",
			env: {
				APP_URL: "http://127.0.0.1:2137/dev/app",
				HOME: "/home/user",
				SHARED: "connection",
			},
			shell: false,
			stdio: "inherit",
		});
	});

	it("forwards signals only while the child is owned and maps signal exits", async () => {
		const child = fakeChild();
		const signals = signalSource();
		const running = runChildCommand(
			{ argv: ["app"], connectionEnv: {}, cwd: "/project", inheritedEnv: {} },
			{ signals: signals.source, spawn: () => child.process },
		);

		signals.emit("SIGINT");
		expect(child.process.kill).toHaveBeenCalledWith("SIGINT");
		child.close(null, "SIGINT");
		await expect(running).resolves.toBe(130);
		expect(signals.listenerCount()).toBe(0);
	});

	it("passes through real child exit codes", async () => {
		await expect(
			runChildCommand({
				argv: [execPath, "-e", "process.exit(23)"],
				connectionEnv: {},
				cwd: process.cwd(),
				inheritedEnv: process.env,
			}),
		).resolves.toBe(23);
	});

	it("owns synchronous and asynchronous spawn failures", async () => {
		const synchronous = new Error("sync spawn failure");
		await expect(
			runChildCommand(
				{ argv: ["missing"], connectionEnv: {}, cwd: "/project", inheritedEnv: {} },
				{
					signals: signalSource().source,
					spawn: () => {
						throw synchronous;
					},
				},
			),
		).rejects.toMatchObject({ cause: synchronous, name: "ChildCommandStartError" });

		const child = fakeChild();
		const asynchronous = new Error("async spawn failure");
		const running = runChildCommand(
			{ argv: ["missing"], connectionEnv: {}, cwd: "/project", inheritedEnv: {} },
			{ signals: signalSource().source, spawn: () => child.process },
		);
		child.error(asynchronous);
		await expect(running).rejects.toBeInstanceOf(ChildCommandStartError);
	});

	it("rejects empty/NUL argv and env before spawning", async () => {
		const spawn = vi.fn<ChildCommandSpawner>();
		for (const options of [
			{ argv: [], connectionEnv: {}, cwd: "/project", inheritedEnv: {} },
			{ argv: ["bad\0name"], connectionEnv: {}, cwd: "/project", inheritedEnv: {} },
			{ argv: ["app"], connectionEnv: { BAD: "value\0tail" }, cwd: "/project", inheritedEnv: {} },
		]) {
			await expect(
				Reflect.apply(runChildCommand, undefined, [options, { spawn }]),
			).rejects.toBeInstanceOf(TypeError);
		}
		expect(spawn).not.toHaveBeenCalled();
	});
});

function fakeChild() {
	const emitter = new EventEmitter();
	const process = Object.assign(emitter, { kill: vi.fn(() => true) });
	return {
		close(code: number | null, signal: NodeJS.Signals | null) {
			emitter.emit("close", code, signal);
		},
		error(cause: unknown) {
			emitter.emit("error", cause);
		},
		process: process as unknown as import("node:child_process").ChildProcess,
	};
}

function signalSource() {
	const listeners = new Map<string, Set<() => void>>();
	const source: ChildCommandSignalSource = {
		subscribe(signal, listener) {
			const entries = listeners.get(signal) ?? new Set();
			entries.add(listener);
			listeners.set(signal, entries);
			return () => entries.delete(listener);
		},
	};
	return {
		emit(signal: "SIGHUP" | "SIGINT" | "SIGTERM") {
			for (const listener of listeners.get(signal) ?? []) listener();
		},
		listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
		source,
	};
}
