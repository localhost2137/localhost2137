import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpServerCloseTimeoutError, NodeHttpServer } from "../../src/node/http-server.js";

describe("NodeHttpServer", () => {
	it("binds an OS-assigned loopback port and closes idempotently", async () => {
		const app = new Hono();
		app.get("/health", (context) => context.json({ ok: true, requestUrl: context.req.url }));
		const server = new NodeHttpServer(app);
		const nativeRequest = globalThis.Request;
		const nativeResponse = globalThis.Response;

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const response = await fetch(`${address.url}/health`);

		expect(address.port).toBeGreaterThan(0);
		expect(globalThis.Request).toBe(nativeRequest);
		expect(globalThis.Response).toBe(nativeResponse);
		expect(await response.json()).toEqual({
			ok: true,
			requestUrl: `${address.url}/health`,
		});
		const firstClose = server.close(1_000);
		expect(server.close(1_000)).toBe(firstClose);
		await firstClose;
		await server.settled();
		await expect(fetch(`${address.url}/health`)).rejects.toThrow();
	});

	it("reports its deadline without abandoning an active response body", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const app = new Hono();
		app.get("/stream", (context) =>
			context.body(
				new ReadableStream<Uint8Array>({
					start(value) {
						controller = value;
						value.enqueue(new TextEncoder().encode("first"));
					},
				}),
			),
		);
		const server = new NodeHttpServer(app);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const response = await fetch(`${address.url}/stream`);
		if (!controller) throw new Error("Expected streaming route to start.");
		let settled = false;

		const close = server.close(10);
		void server.settled().then(() => {
			settled = true;
		});
		const failure = await close.catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(HttpServerCloseTimeoutError);
		expect(failure).toMatchObject({ activeRequests: 1, timeoutMs: 10 });
		expect(settled).toBe(false);
		controller.close();
		expect(await response.text()).toBe("first");
		await server.settled();
		expect(settled).toBe(true);
	});

	it("reports port conflicts without claiming a listening address", async () => {
		const first = new NodeHttpServer(new Hono());
		const firstAddress = await first.start({ host: "127.0.0.1", port: 0 });
		const second = new NodeHttpServer(new Hono());

		await expect(
			second.start({ host: "127.0.0.1", port: firstAddress.port }),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
		await second.close(1_000);
		await second.settled();
		await first.close(1_000);
	});

	it("rejects invalid ports before allocating a server", async () => {
		const server = new NodeHttpServer(new Hono());

		await expect(server.start({ host: "127.0.0.1", port: -1 })).rejects.toThrow("HTTP server port");
		await server.close(1_000);
		await server.settled();
	});
});
