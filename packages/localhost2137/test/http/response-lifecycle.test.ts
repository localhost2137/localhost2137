import { describe, expect, it, vi } from "vitest";
import { responseWithFinalizer } from "../../src/http/response-lifecycle.js";

describe("responseWithFinalizer", () => {
	it("finalizes a bodyless response immediately", () => {
		const finalize = vi.fn();
		const response = new Response(null, { status: 204 });

		expect(responseWithFinalizer(response, finalize)).toBe(response);
		expect(finalize).toHaveBeenCalledOnce();
	});

	it("finalizes exactly once at stream EOF", async () => {
		const finalize = vi.fn();
		const response = responseWithFinalizer(new Response("complete"), finalize);

		expect(await response.text()).toBe("complete");
		expect(finalize).toHaveBeenCalledOnce();
	});

	it("finalizes exactly once when the consumer cancels", async () => {
		const finalize = vi.fn();
		const upstreamCancel = vi.fn();
		const response = responseWithFinalizer(
			new Response(new ReadableStream({ cancel: upstreamCancel })),
			finalize,
		);

		await response.body?.cancel("consumer finished");

		expect(upstreamCancel).toHaveBeenCalledWith("consumer finished");
		expect(finalize).toHaveBeenCalledOnce();
	});

	it("finalizes exactly once when the upstream reader fails", async () => {
		const failure = new Error("stream read failed");
		const finalize = vi.fn();
		const response = responseWithFinalizer(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(failure);
					},
				}),
			),
			finalize,
		);

		await expect(response.text()).rejects.toBe(failure);
		expect(finalize).toHaveBeenCalledOnce();
	});
});
