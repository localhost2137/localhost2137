import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type SupervisedProcess, stopSupervisedProcess } from "../src/durability-process.js";
import {
	installSupervisorProtocol,
	ownSupervisorCliArguments,
	SUPERVISOR_SHUTDOWN_MESSAGE,
} from "../src/durability-supervisor.js";

describe("durability supervisor", () => {
	it("delivers one cooperative interrupt for the exact private message", () => {
		const fixture = protocolFixture();
		fixture.message({ type: SUPERVISOR_SHUTDOWN_MESSAGE });
		fixture.message("malformed");
		expect(fixture.interrupt).not.toHaveBeenCalled();

		fixture.message(SUPERVISOR_SHUTDOWN_MESSAGE);
		fixture.message(SUPERVISOR_SHUTDOWN_MESSAGE);
		fixture.disconnect();
		expect(fixture.interrupt).toHaveBeenCalledTimes(1);
	});

	it("interrupts once when the parent IPC channel disconnects", () => {
		const fixture = protocolFixture();
		fixture.disconnect();
		fixture.disconnect();
		fixture.message(SUPERVISOR_SHUTDOWN_MESSAGE);
		expect(fixture.interrupt).toHaveBeenCalledTimes(1);
	});

	it("accepts only the intended daemon argv", () => {
		const config = fileURLToPath(
			new URL("./fixtures/durability-daemon.config.ts", import.meta.url),
		);
		expect(ownSupervisorCliArguments(["--config", config, "dev", "--port", "2137"])).toEqual([
			"--config",
			config,
			"dev",
			"--port",
			"2137",
		]);
		expect(() => ownSupervisorCliArguments(["--config", config, "dev", "--port", "0"])).toThrow(
			TypeError,
		);
		expect(() =>
			ownSupervisorCliArguments(["--config", config, "other", "--port", "2137"]),
		).toThrow(TypeError);
		expect(() =>
			ownSupervisorCliArguments(["--config", "relative.ts", "dev", "--port", "2137"]),
		).toThrow(TypeError);
	});

	it("uses IPC rather than an OS signal for cooperative shutdown", async () => {
		const fixture = processFixture();
		fixture.onSend(() => fixture.close(0));
		await expect(stopSupervisedProcess(fixture.child, fixture.closed, 20)).resolves.toEqual({
			exitCode: 0,
			forced: false,
		});
		expect(fixture.messages).toEqual([SUPERVISOR_SHUTDOWN_MESSAGE]);
		expect(fixture.signals).toEqual([]);
	});

	it("returns an early exit without sending or signaling", async () => {
		const fixture = processFixture({ exitCode: 1 });
		fixture.close(1);
		await expect(stopSupervisedProcess(fixture.child, fixture.closed, 20)).resolves.toEqual({
			exitCode: 1,
			forced: false,
		});
		expect(fixture.messages).toEqual([]);
		expect(fixture.signals).toEqual([]);
	});

	it("falls back to exact-child SIGKILL when cooperative shutdown stalls", async () => {
		const fixture = processFixture();
		fixture.onKill(() => fixture.close(null, "SIGKILL"));
		await expect(stopSupervisedProcess(fixture.child, fixture.closed, 5)).resolves.toEqual({
			exitCode: null,
			forced: true,
		});
		expect(fixture.messages).toEqual([SUPERVISOR_SHUTDOWN_MESSAGE]);
		expect(fixture.signals).toEqual(["SIGKILL"]);
	});

	it("contains send callback failures and completes forced cleanup", async () => {
		const fixture = processFixture();
		fixture.onSend((callback) => callback(new Error("IPC closed")));
		fixture.onKill(() => fixture.close(null, "SIGKILL"));
		await expect(stopSupervisedProcess(fixture.child, fixture.closed, 20)).resolves.toEqual({
			exitCode: null,
			forced: true,
		});
		expect(fixture.signals).toEqual(["SIGKILL"]);
	});

	it("handles a disconnected parent channel with exact-child fallback", async () => {
		const fixture = processFixture({ connected: false });
		fixture.onKill(() => fixture.close(null, "SIGKILL"));
		await expect(stopSupervisedProcess(fixture.child, fixture.closed, 20)).resolves.toEqual({
			exitCode: null,
			forced: true,
		});
		expect(fixture.messages).toEqual([]);
		expect(fixture.signals).toEqual(["SIGKILL"]);
	});
});

function protocolFixture() {
	let disconnectListener: (() => void) | undefined;
	let messageListener: ((message: unknown) => void) | undefined;
	const interrupt = vi.fn();
	installSupervisorProtocol({
		emitInterrupt: interrupt,
		onDisconnect(listener) {
			disconnectListener = listener;
			return () => {
				disconnectListener = undefined;
			};
		},
		onMessage(listener) {
			messageListener = listener;
			return () => {
				messageListener = undefined;
			};
		},
	});
	return {
		disconnect: () => disconnectListener?.(),
		interrupt,
		message: (message: unknown) => messageListener?.(message),
	};
}

function processFixture(input: Readonly<{ connected?: boolean; exitCode?: number | null }> = {}) {
	let close!: (code: number | null) => void;
	let sendImplementation: (callback: (error: Error | null) => void) => void = () => undefined;
	let killImplementation = () => undefined;
	const messages: unknown[] = [];
	const signals: string[] = [];
	const closed = new Promise<number | null>((resolve) => {
		close = resolve;
	});
	const child: SupervisedProcess = {
		connected: input.connected ?? true,
		exitCode: input.exitCode ?? null,
		kill(signal) {
			signals.push(signal);
			killImplementation();
			return true;
		},
		send(message, callback) {
			messages.push(message);
			sendImplementation(callback);
			return true;
		},
		signalCode: null,
	};
	return {
		child,
		close(code: number | null, signal?: NodeJS.Signals) {
			Object.assign(child, { exitCode: code, signalCode: signal ?? null });
			close(code);
		},
		closed,
		messages,
		onKill(implementation: () => void) {
			killImplementation = implementation;
		},
		onSend(implementation: (callback: (error: Error | null) => void) => void) {
			sendImplementation = implementation;
		},
		signals,
	};
}
