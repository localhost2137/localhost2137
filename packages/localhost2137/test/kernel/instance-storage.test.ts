import { describe, expect, it } from "vitest";
import { InstanceStagingError } from "../../src/kernel/instance-storage.js";

describe("InstanceStagingError", () => {
	it.each([
		[false, "Instance staging failed."],
		[true, "Instance was staged but its directory sync failed."],
	] as const)(
		"records whether filesystem staging crossed its rename boundary",
		(staged, message) => {
			const cause = new Error("filesystem failure");
			const error = new InstanceStagingError(staged, cause);

			expect(error).toMatchObject({ cause, message, staged });
		},
	);
});
