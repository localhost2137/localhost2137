import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

it("reads seeded users through Slack-shaped HTTP", async () => {
	const runtime = await createTestRuntime({
		config,
		port: 0,
		storage: "temporary",
	});

	try {
		const instance = await runtime.createInstance({ seed: true });
		try {
			const response = await fetch(new URL("users.list", instance.slack.connection.apiUrl), {
				headers: {
					authorization: `Bearer ${instance.slack.connection.botToken}`,
				},
			});

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				members: [
					{ id: "U000000", name: "localhost2137-bot" },
					{ id: "U_ADA", name: "Ada" },
				],
				ok: true,
			});
		} finally {
			await instance.destroy();
		}
	} finally {
		await runtime.close();
	}
});
