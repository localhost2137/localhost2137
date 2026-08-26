import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpServerAddress } from "../../src/node/http-server.js";
import {
	type HttpServerOwner,
	type InstanceRuntimeOwner,
	RuntimeServer,
	RuntimeServerCloseTimeoutError,
} from "../../src/node/runtime-server.js";

const ADDRESS: HttpServerAddress = Object.freeze({
	host: "127.0.0.1",
	port: 21_337,
	url: "http://127.0.0.1:21337",
});

afterEach(() => vi.useRealTimers());

describe("RuntimeServer", () => {
	it("starts persisted instances before binding HTTP", async () => {
		const events: string[] = [];
		const fixture = owners();
		fixture.runtime.startPersisted.mockImplementation(async () => {
			events.push("runtime:start");
		});
		fixture.http.start.mockImplementation(async () => {
			events.push("http:start");
			return ADDRESS;
		});
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		await expect(server.start({ host: "127.0.0.1", port: 0 })).resolves.toBe(ADDRESS);
		expect(events).toEqual(["runtime:start", "http:start"]);
		expect(fixture.runtime.startPersisted).toHaveBeenCalledOnce();
	});

	it("memoizes explicit preparation and start awaits the same runtime work", async () => {
		const events: string[] = [];
		const fixture = owners();
		const runtimeStarted = deferred<void>();
		fixture.runtime.startPersisted.mockImplementation(() => {
			events.push("runtime:prepare");
			return runtimeStarted.promise;
		});
		fixture.http.start.mockImplementation(async () => {
			events.push("http:start");
			return ADDRESS;
		});
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		const preparation = server.prepare();
		expect(server.prepare()).toBe(preparation);
		const started = server.start({ host: "127.0.0.1", port: 0 });
		expect(events).toEqual(["runtime:prepare"]);
		runtimeStarted.resolve();

		await expect(preparation).resolves.toBeUndefined();
		await expect(started).resolves.toBe(ADDRESS);
		expect(events).toEqual(["runtime:prepare", "http:start"]);
		expect(fixture.runtime.startPersisted).toHaveBeenCalledOnce();
	});

	it("memoizes preparation failures and never binds HTTP", async () => {
		const fixture = owners();
		const failure = new Error("persisted runtime failed");
		fixture.runtime.startPersisted.mockRejectedValue(failure);
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		const preparation = server.prepare();
		expect(server.prepare()).toBe(preparation);
		await expect(preparation).rejects.toBe(failure);
		await expect(server.start({ host: "127.0.0.1", port: 0 })).rejects.toBe(failure);

		expect(fixture.runtime.startPersisted).toHaveBeenCalledOnce();
		expect(fixture.http.start).not.toHaveBeenCalled();
	});

	it("rejects untyped host values before starting either owner", async () => {
		const fixture = owners();
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		await expect(
			Reflect.apply(server.start, server, [{ host: "0.0.0.0", port: 0 }]),
		).rejects.toThrow("HTTP server host");
		expect(fixture.runtime.startPersisted).not.toHaveBeenCalled();
		expect(fixture.http.start).not.toHaveBeenCalled();
	});

	it("owns host and port before asynchronous runtime startup", async () => {
		const fixture = owners();
		const runtimeStarted = deferred<void>();
		fixture.runtime.startPersisted.mockReturnValue(runtimeStarted.promise);
		const server = new RuntimeServer(fixture.runtime, fixture.http);
		const options = { host: "127.0.0.1" as const, port: 0 };

		const started = server.start(options);
		Reflect.set(options, "host", "0.0.0.0");
		Reflect.set(options, "port", 65_535);
		runtimeStarted.resolve();
		await started;

		expect(fixture.http.start).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });
		const owned = fixture.http.start.mock.calls[0]?.[0];
		expect(Object.isFrozen(owned)).toBe(true);
	});

	it("rejects host and port accessors before starting either owner", async () => {
		for (const property of ["host", "port"] as const) {
			const fixture = owners();
			const server = new RuntimeServer(fixture.runtime, fixture.http);
			const read = vi.fn(() => (property === "host" ? "127.0.0.1" : 0));
			const options = { host: "127.0.0.1", port: 0 };
			Object.defineProperty(options, property, { enumerable: true, get: read });

			await expect(Reflect.apply(server.start, server, [options])).rejects.toThrow(
				`HTTP server ${property} must be an own data property.`,
			);
			expect(read).not.toHaveBeenCalled();
			expect(fixture.runtime.startPersisted).not.toHaveBeenCalled();
		}
	});

	it("starts both close owners and keeps settlement distinct from bounded reports", async () => {
		const fixture = owners();
		const httpSettlement = deferred<void>();
		const runtimeSettlement = deferred<void>();
		fixture.http.close.mockRejectedValue(new Error("http deadline"));
		fixture.runtime.stopAll.mockRejectedValue(new Error("runtime deadline"));
		fixture.http.settled.mockReturnValue(httpSettlement.promise);
		fixture.runtime.settled.mockReturnValue(runtimeSettlement.promise);
		const server = new RuntimeServer(fixture.runtime, fixture.http);
		await server.start({ host: "127.0.0.1", port: 0 });

		const report = server.close(25);
		const settlement = server.settled();
		expect(server.close(25)).toBe(report);
		expect(server.settled()).toBe(settlement);
		const failure = await report.catch((cause: unknown) => cause);
		let settled = false;
		void settlement.then(() => {
			settled = true;
		});

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toHaveLength(2);
		expect(fixture.http.close).toHaveBeenCalledWith(25);
		expect(fixture.runtime.stopAll).toHaveBeenCalledWith({ timeoutMs: 25 });
		expect(settled).toBe(false);
		httpSettlement.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		runtimeSettlement.resolve();
		await settlement;
		expect(settled).toBe(true);
	});

	it("stops and fully settles the instance runtime when HTTP binding fails", async () => {
		const fixture = owners();
		fixture.http.start.mockRejectedValue(new Error("port unavailable"));
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		const failure = await server
			.start({ host: "127.0.0.1", port: 21_337 })
			.catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(AggregateError);
		expect(fixture.runtime.stopAll).toHaveBeenCalledWith({ timeoutMs: 30_000 });
		expect(fixture.runtime.settled).toHaveBeenCalledOnce();
	});

	it("bounds the first close report independently after fatal owner shutdown starts", async () => {
		vi.useFakeTimers();
		const fixture = owners();
		const httpReport = deferred<void>();
		const runtimeReport = deferred<void>();
		const httpSettlement = deferred<void>();
		const runtimeSettlement = deferred<void>();
		const fatal = new Error("accept loop failed");
		fixture.http.close.mockReturnValue(httpReport.promise);
		fixture.runtime.stopAll.mockReturnValue(runtimeReport.promise);
		fixture.http.settled.mockReturnValue(httpSettlement.promise);
		fixture.runtime.settled.mockReturnValue(runtimeSettlement.promise);
		let notifyFatal: ((cause: unknown) => void) | undefined;
		fixture.http.onFatal.mockImplementation((listener) => {
			notifyFatal = listener;
			return () => undefined;
		});
		const server = new RuntimeServer(fixture.runtime, fixture.http);

		notifyFatal?.(fatal);
		const settlement = server.settled();
		const report = server.close(5);

		expect(server.close(1_000)).toBe(report);
		expect(server.settled()).toBe(settlement);
		expect(fixture.runtime.stopAll).toHaveBeenCalledOnce();
		expect(fixture.runtime.stopAll).toHaveBeenCalledWith({ timeoutMs: 30_000 });
		expect(fixture.http.close).toHaveBeenCalledOnce();
		expect(fixture.http.close).toHaveBeenCalledWith(30_000);
		let reportSettled = false;
		void report
			.catch(() => undefined)
			.then(() => {
				reportSettled = true;
			});
		await vi.advanceTimersByTimeAsync(4);
		expect(reportSettled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(report).rejects.toMatchObject({ timeoutMs: 5 });
		expect(await report.catch((cause: unknown) => cause)).toBeInstanceOf(
			RuntimeServerCloseTimeoutError,
		);
		let settled = false;
		void settlement
			.catch(() => undefined)
			.then(() => {
				settled = true;
			});
		httpSettlement.reject(fatal);
		await Promise.resolve();
		expect(settled).toBe(false);
		const runtimeFailure = new Error("runtime cleanup failed");
		runtimeSettlement.reject(runtimeFailure);
		await expect(settlement).rejects.toMatchObject({ errors: [fatal, runtimeFailure] });
		expect(settled).toBe(true);
		httpReport.resolve();
		runtimeReport.resolve();
		vi.useRealTimers();
	});

	it("notifies fatal observers once, contains observer failures, and replays the cause", () => {
		const fixture = owners();
		let notifyFatal: ((cause: unknown) => void) | undefined;
		fixture.http.onFatal.mockImplementation((listener) => {
			notifyFatal = listener;
			return () => undefined;
		});
		const server = new RuntimeServer(fixture.runtime, fixture.http);
		const first = vi.fn(() => {
			throw new Error("observer failed");
		});
		const second = vi.fn();
		server.onFatal(first);
		server.onFatal(second);
		const fatal = new Error("accept loop failed");

		expect(() => notifyFatal?.(fatal)).not.toThrow();
		notifyFatal?.(new Error("later failure"));
		const replayed = vi.fn();
		server.onFatal(replayed);

		expect(first).toHaveBeenCalledOnce();
		expect(first).toHaveBeenCalledWith(fatal);
		expect(second).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledWith(fatal);
		expect(replayed).toHaveBeenCalledOnce();
		expect(replayed).toHaveBeenCalledWith(fatal);
		expect(fixture.runtime.stopAll).toHaveBeenCalledOnce();
	});
});

function owners(): Readonly<{
	http: MockedHttpOwner;
	runtime: MockedRuntimeOwner;
}> {
	return {
		http: {
			close: vi.fn(async () => undefined),
			onFatal: vi.fn(() => () => undefined),
			settled: vi.fn(async () => undefined),
			start: vi.fn(async () => ADDRESS),
		},
		runtime: {
			settled: vi.fn(async () => undefined),
			startPersisted: vi.fn(async () => undefined),
			stopAll: vi.fn(async () => undefined),
		},
	};
}

type MockedHttpOwner = HttpServerOwner & {
	readonly close: ReturnType<typeof vi.fn<HttpServerOwner["close"]>>;
	readonly onFatal: ReturnType<typeof vi.fn<HttpServerOwner["onFatal"]>>;
	readonly settled: ReturnType<typeof vi.fn<HttpServerOwner["settled"]>>;
	readonly start: ReturnType<typeof vi.fn<HttpServerOwner["start"]>>;
};

type MockedRuntimeOwner = InstanceRuntimeOwner & {
	readonly settled: ReturnType<typeof vi.fn<InstanceRuntimeOwner["settled"]>>;
	readonly startPersisted: ReturnType<typeof vi.fn<InstanceRuntimeOwner["startPersisted"]>>;
	readonly stopAll: ReturnType<typeof vi.fn<InstanceRuntimeOwner["stopAll"]>>;
};

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	reject(cause: unknown): void;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<Value>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return Object.freeze({ promise, reject, resolve });
}
