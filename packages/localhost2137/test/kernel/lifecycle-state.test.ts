import { describe, expect, it } from "vitest";
import {
	InstanceLifecycleStateOwner,
	InvalidLifecycleTransitionError,
	ServiceLifecycleStateOwner,
} from "../../src/kernel/lifecycle-state.js";

describe("ServiceLifecycleStateOwner", () => {
	it("models create, update, start, seed, and stop explicitly", () => {
		const owner = new ServiceLifecycleStateOwner<{ open: boolean }>();
		owner.beginCreate();
		expect(owner.status()).toBe("creating");
		owner.createSucceeded();
		owner.beginUpdate();
		expect(owner.status()).toBe("updating");
		owner.updateFinished();
		owner.beginStart();
		owner.startSucceeded({ open: true });
		expect(owner.runningState()).toEqual({ open: true });
		expect(owner.beginSeed()).toEqual({ open: true });
		owner.seedFinished();
		expect(owner.beginStop()).toEqual({ open: true });
		owner.stopFinished(true);
		expect(owner.status()).toBe("stopped");
	});

	it("returns to a safe state after create, update, and start failures", () => {
		const create = new ServiceLifecycleStateOwner<never>();
		create.beginCreate();
		create.createFailed();
		expect(create.status()).toBe("absent");

		const update = stoppedService();
		update.beginUpdate();
		update.updateFinished();
		expect(update.status()).toBe("stopped");

		const start = stoppedService();
		start.beginStart();
		start.startFailed();
		expect(start.status()).toBe("stopped");
	});

	it("records a stop failure so the successful start is never stopped twice", () => {
		const owner = runningService();
		owner.beginStop();
		owner.stopFinished(false);
		expect(owner.status()).toBe("stop_failed");
		expect(() => owner.beginStop()).toThrow(InvalidLifecycleTransitionError);
	});

	it("rejects illegal transitions with owner, state, and action", () => {
		const owner = new ServiceLifecycleStateOwner<never>();
		expect(() => owner.beginStart()).toThrowError(
			expect.objectContaining({ action: "start", owner: "service", status: "absent" }),
		);
	});
});

describe("InstanceLifecycleStateOwner", () => {
	it("models start, seed failure, stop, reset rollback, and destroy", () => {
		const owner = new InstanceLifecycleStateOwner();
		owner.beginStart();
		owner.startFinished(true);
		owner.beginSeed();
		owner.seedFinished(false);
		expect(owner.status()).toBe("seed_failed");
		owner.beginStop();
		owner.stopFinished(true);
		const previous = owner.beginReset();
		expect(previous).toBe("stopped");
		owner.restoreAfterResetFailure(previous);
		owner.beginDestroy();
		expect(owner.status()).toBe("destroying");
	});

	it("rejects repeated seed and destroy while running", () => {
		const owner = new InstanceLifecycleStateOwner("running");
		owner.beginSeed();
		owner.seedFinished(true);
		expect(() => owner.beginDestroy()).toThrow(InvalidLifecycleTransitionError);
		owner.beginSeed();
		expect(() => owner.beginSeed()).toThrow(InvalidLifecycleTransitionError);
	});
});

function stoppedService(): ServiceLifecycleStateOwner<never> {
	const owner = new ServiceLifecycleStateOwner<never>();
	owner.beginCreate();
	owner.createSucceeded();
	return owner;
}

function runningService(): ServiceLifecycleStateOwner<{ open: boolean }> {
	const owner = new ServiceLifecycleStateOwner<{ open: boolean }>();
	owner.beginCreate();
	owner.createSucceeded();
	owner.beginStart();
	owner.startSucceeded({ open: true });
	return owner;
}
