import { describe, expect, it } from "vitest";
import {
	RuntimeAdmission,
	RuntimeAdmissionClosedError,
} from "../../src/kernel/runtime-admission.js";

describe("RuntimeAdmission", () => {
	it("closes admission before abort notification and waits for admitted work", async () => {
		const admission = new RuntimeAdmission();
		const active = admission.admit();
		let reentrantFailure: unknown;
		active.signal.addEventListener("abort", () => {
			try {
				admission.admit();
			} catch (cause) {
				reentrantFailure = cause;
			}
		});
		let closed = false;
		const close = admission.close("shutdown").then(() => {
			closed = true;
		});

		await Promise.resolve();
		expect(reentrantFailure).toBeInstanceOf(RuntimeAdmissionClosedError);
		expect(active.signal).toMatchObject({ aborted: true, reason: "shutdown" });
		expect(closed).toBe(false);
		expect(() => admission.assertOpen()).toThrow(RuntimeAdmissionClosedError);
		active.release();
		await close;
		expect(closed).toBe(true);
	});

	it("returns one close promise and makes releases idempotent", async () => {
		const admission = new RuntimeAdmission();
		const active = admission.admit();
		const first = admission.close("shutdown");
		const second = admission.close("ignored");

		expect(second).toBe(first);
		active.release();
		active.release();
		await first;
	});
});
