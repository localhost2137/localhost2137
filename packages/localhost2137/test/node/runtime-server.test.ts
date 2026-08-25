import { describe, expect, it, vi } from "vitest";
import type { HttpServerAddress } from "../../src/node/http-server.js";
import {
	type HttpServerOwner,
	type InstanceRuntimeOwner,
	RuntimeServer,
} from "../../src/node/runtime-server.js";

const ADDRESS: HttpServerAddress = Object.freeze({
	host: "127.0.0.1",
	port: 21_337,
	url: "http://127.0.0.1:21337",
});

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
		const failure = await report.catch((cause: unknown) => cause);
		let settled = false;
		void server.settled().then(() => {
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
		await server.settled();
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
});

function owners(): Readonly<{
	http: MockedHttpOwner;
	runtime: MockedRuntimeOwner;
}> {
	return {
		http: {
			close: vi.fn(async () => undefined),
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
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}
