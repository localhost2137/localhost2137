import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

it("reports one exact instance-clock transition", async () => {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	try {
		const instance = await runtime.createInstance();
		try {
			expect(await instance.clock.status()).toEqual({
				mode: "pinned",
				now: "2026-01-01T00:00:00.000Z",
			});

			const advanced = await instance.clock.advance("2h");
			expect(advanced).toMatchObject({
				from: "2026-01-01T00:00:00.000Z",
				mode: "pinned",
				to: "2026-01-01T02:00:00.000Z",
			});
			expect(advanced.advanceId.length).toBeGreaterThan(0);

			await instance.idle();
			expect(await instance.clock.status()).toEqual({
				mode: "pinned",
				now: "2026-01-01T02:00:00.000Z",
			});
		} finally {
			await instance.destroy();
		}
	} finally {
		await runtime.close();
	}
});
