import { describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/config-resolution.js";
import {
	DevDaemonFatalError,
	runDevCommand,
	type SignalInterruption,
} from "../../src/node/dev-command.js";
import type { DevDaemon } from "../../src/node/dev-daemon.js";

describe("foreground dev command", () => {
	it("prints secret-free readiness and fully closes after SIGINT", async () => {
		const signals = signalFixture();
		const fatal = deferred<unknown>();
		const close = vi.fn(async () => undefined);
		const daemon = daemonFixture(fatal.promise, close);
		const writeError = vi.fn();
		const running = runDevCommand(
			{
				cwd: "/project",
				io: { writeError, writeOutput: vi.fn() },
				options: { port: 21_337 },
			},
			{ signals, startDaemon: vi.fn(async () => daemon) },
		);
		await vi.waitFor(() => expect(writeError).toHaveBeenCalledOnce());

		signals.emit("SIGINT");
		await expect(running).rejects.toMatchObject<Partial<SignalInterruption>>({
			name: "SignalInterruption",
			signal: "SIGINT",
		});

		const output = String(writeError.mock.calls[0]?.[0]);
		expect(output).toContain("runtime: http://127.0.0.1:21337");
		expect(output).toContain("fixture: http://127.0.0.1:21337/dev/fixture");
		expect(output).toContain("variables: PUBLIC_URL, TOKEN");
		expect(output).not.toContain("private-control-token");
		expect(output).not.toContain("private-connection-value");
		expect(close).toHaveBeenCalledOnce();
		expect(signals.listenerCount()).toBe(0);
	});

	it("rethrows a contained fatal failure only after daemon cleanup", async () => {
		const events: string[] = [];
		const signals = signalFixture();
		const fatal = deferred<unknown>();
		const close = vi.fn(async () => {
			events.push("close");
		});
		const cause = new Error("accept loop failed");
		const running = runDevCommand(
			{
				cwd: "/project",
				io: { writeError: vi.fn(), writeOutput: vi.fn() },
				options: {},
			},
			{ signals, startDaemon: vi.fn(async () => daemonFixture(fatal.promise, close)) },
		);
		fatal.resolve(cause);

		const failure = await running.catch((error: unknown) => {
			events.push("reject");
			return error;
		});
		expect(failure).toBeInstanceOf(DevDaemonFatalError);
		expect(failure).toMatchObject({ cause });
		expect(events).toEqual(["close", "reject"]);
		expect(signals.listenerCount()).toBe(0);
	});
});

function daemonFixture(fatal: Promise<unknown>, close: () => Promise<void>): DevDaemon {
	const config = {
		services: { fixture: {} },
	} as unknown as ResolvedConfig;
	return Object.freeze({
		address: Object.freeze({
			host: "127.0.0.1" as const,
			port: 21_337,
			url: "http://127.0.0.1:21337",
		}),
		close,
		config,
		connections: Object.freeze({
			env: Object.freeze({ PUBLIC_URL: "https://public.test", TOKEN: "private-connection-value" }),
			services: Object.freeze({}),
		}),
		descriptor: Object.freeze({
			configFingerprint: `sha256:${"0".repeat(64)}`,
			ownerId: "owner_0123456789012345",
			pid: 12_345,
			protocolVersion: "v1" as const,
			schemaVersion: 1 as const,
			startedAt: "2026-08-26T00:00:00.000Z",
			url: "http://127.0.0.1:21337",
		}),
		environmentPath: "/project/.localhost2137/.env",
		fatal,
	});
}

function signalFixture() {
	type Signal = "SIGINT" | "SIGTERM";
	const listeners = new Map<Signal, Set<() => void>>();
	return {
		emit(signal: Signal) {
			for (const listener of listeners.get(signal) ?? []) listener();
		},
		listenerCount() {
			return [...listeners.values()].reduce((count, entries) => count + entries.size, 0);
		},
		subscribe(signal: Signal, listener: () => void) {
			const entries = listeners.get(signal) ?? new Set();
			entries.add(listener);
			listeners.set(signal, entries);
			return () => entries.delete(listener);
		},
	};
}

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}
