import { ControlApiError, ControlTransportError } from "localhost2137/client";
import { describe, expect, it, vi } from "vitest";
import { withOwnedInstance } from "./owned-instance.js";

describe("worker instance ownership", () => {
	it("creates, uses, and destroys one known ephemeral instance", async () => {
		const order: string[] = [];
		const runtime = {
			createInstance: vi.fn(async () => {
				order.push("create");
				return {};
			}),
			destroyInstance: vi.fn(async () => {
				order.push("destroy");
				return {};
			}),
		};

		await expect(
			withOwnedInstance(runtime, "worker-1", async () => {
				order.push("use");
				return 2137;
			}),
		).resolves.toBe(2137);
		expect(order).toEqual(["create", "use", "destroy"]);
		expect(runtime.createInstance).toHaveBeenCalledWith({
			id: "worker-1",
			persistence: "ephemeral",
		});
		expect(runtime.destroyInstance).toHaveBeenCalledWith("worker-1");
	});

	it("does not destroy an instance rejected as an authoritative conflict", async () => {
		const conflict = new ControlApiError({
			code: "INSTANCE_CONFLICT",
			correlationId: "create-1",
			message: "Instance already exists.",
			status: 409,
		});
		const runtime = {
			createInstance: vi.fn(async () => {
				throw conflict;
			}),
			destroyInstance: vi.fn(async () => ({})),
		};
		const use = vi.fn(async () => undefined);

		await expect(withOwnedInstance(runtime, "worker-2", use)).rejects.toBe(conflict);
		expect(use).not.toHaveBeenCalled();
		expect(runtime.destroyInstance).not.toHaveBeenCalled();
	});

	it("preserves a failed create when reconciliation confirms the instance is absent", async () => {
		const primary = new ControlTransportError(new Error("response lost"), false);
		const absent = new ControlApiError({
			code: "INSTANCE_NOT_FOUND",
			correlationId: "cleanup-1",
			message: "Instance not found.",
			status: 404,
		});
		const runtime = {
			createInstance: vi.fn(async () => {
				throw primary;
			}),
			destroyInstance: vi.fn(async () => {
				throw absent;
			}),
		};
		const use = vi.fn(async () => undefined);

		await expect(withOwnedInstance(runtime, "worker-3", use)).rejects.toBe(primary);
		expect(use).not.toHaveBeenCalled();
		expect(runtime.destroyInstance).toHaveBeenCalledWith("worker-3");
	});

	it("destroys an instance committed before its create response was lost", async () => {
		const primary = new ControlTransportError(new Error("response lost"), false);
		let present = false;
		const runtime = {
			createInstance: vi.fn(async () => {
				present = true;
				throw primary;
			}),
			destroyInstance: vi.fn(async () => {
				expect(present).toBe(true);
				present = false;
				return {};
			}),
		};

		await expect(withOwnedInstance(runtime, "worker-4", async () => undefined)).rejects.toBe(
			primary,
		);
		expect(present).toBe(false);
		expect(runtime.destroyInstance).toHaveBeenCalledWith("worker-4");
	});

	it("reports cleanup failure without hiding the uncertain create failure", async () => {
		const primary = new ControlTransportError(new Error("response lost"), false);
		const cleanup = new ControlApiError({
			code: "LIFECYCLE_CONFLICT",
			correlationId: "cleanup-2",
			message: "Instance is busy.",
			status: 409,
		});
		const runtime = {
			createInstance: vi.fn(async () => {
				throw primary;
			}),
			destroyInstance: vi.fn(async () => {
				throw cleanup;
			}),
		};

		const failure = await withOwnedInstance(runtime, "worker-5", async () => undefined).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
		expect(runtime.destroyInstance).toHaveBeenCalledWith("worker-5");
	});

	it("surfaces cleanup failure after successful use", async () => {
		const cleanup = new ControlTransportError(new Error("runtime unavailable"), false);
		const runtime = {
			createInstance: vi.fn(async () => ({})),
			destroyInstance: vi.fn(async () => {
				throw cleanup;
			}),
		};
		const use = vi.fn(async () => "done");

		await expect(withOwnedInstance(runtime, "worker-6", use)).rejects.toBe(cleanup);
		expect(use).toHaveBeenCalledOnce();
		expect(runtime.destroyInstance).toHaveBeenCalledWith("worker-6");
	});
});
