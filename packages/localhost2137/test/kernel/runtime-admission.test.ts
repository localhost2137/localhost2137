import { describe, expect, it } from "vitest";
import {
	RuntimeAdmission,
	RuntimeAdmissionClosedError,
} from "../../src/kernel/runtime-admission.js";

describe("RuntimeAdmission", () => {
	it("closes new admission while allowing admitted work to drain", async () => {
		const admission = new RuntimeAdmission();
		const active = admission.admit();
		let closed = false;
		const close = admission.close().then(() => {
			closed = true;
		});

		await Promise.resolve();
		expect(active.signal.aborted).toBe(false);
		expect(closed).toBe(false);
		expect(() => admission.admit()).toThrow(RuntimeAdmissionClosedError);
		expect(() => admission.assertOpen()).toThrow(RuntimeAdmissionClosedError);
		active.release();
		await close;
		expect(closed).toBe(true);
	});

	it("returns one close promise and makes releases idempotent", async () => {
		const admission = new RuntimeAdmission();
		const active = admission.admit();
		const first = admission.close();
		const second = admission.close();

		expect(second).toBe(first);
		active.release();
		active.release();
		await first;
	});

	it("aborts retained admitted work only when explicitly requested", async () => {
		const admission = new RuntimeAdmission();
		const active = admission.admit();
		const close = admission.close();

		admission.abort("grace expired");

		expect(active.signal).toMatchObject({ aborted: true, reason: "grace expired" });
		active.release();
		await close;
	});
});
