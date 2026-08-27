import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

it("exposes isolated status through the application API", async () => {
	const runtime = await createTestRuntime({
		config,
		port: 0,
		storage: "temporary",
	});

	try {
		const degraded = await runtime.createInstance();
		try {
			const fresh = await runtime.createInstance();
			try {
				await degraded.status.setStatus({
					message: "database maintenance",
					state: "degraded",
				});

				const degradedResponse = await fetch(`${degraded.status.connection.apiUrl}/v1/status`);
				expect(degradedResponse.status).toBe(200);
				await expect(degradedResponse.json()).resolves.toEqual({
					message: "database maintenance",
					state: "degraded",
				});

				const freshResponse = await fetch(`${fresh.status.connection.apiUrl}/v1/status`);
				expect(freshResponse.status).toBe(200);
				await expect(freshResponse.json()).resolves.toEqual({
					message: null,
					state: "operational",
				});
			} finally {
				await fresh.destroy();
			}
		} finally {
			await degraded.destroy();
		}
	} finally {
		await runtime.close();
	}
});
