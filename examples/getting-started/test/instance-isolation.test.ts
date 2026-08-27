import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

it("isolates service state and routes for two instances of one config", async () => {
	const runtime = await createTestRuntime({
		config,
		port: 0,
		storage: "temporary",
	});

	try {
		const first = await runtime.createInstance();
		try {
			const second = await runtime.createInstance();
			try {
				const firstUrl = new URL(first.slack.connection.apiUrl);
				const secondUrl = new URL(second.slack.connection.apiUrl);
				expect(firstUrl.origin).toBe(secondUrl.origin);
				expect(firstUrl.pathname).not.toBe(secondUrl.pathname);
				expect(firstUrl.pathname.endsWith("/slack/api/")).toBe(true);
				expect(secondUrl.pathname.endsWith("/slack/api/")).toBe(true);

				await first.slack.createUser({ name: "Grace" });

				await expect(readUserNames(first.slack.connection)).resolves.toEqual([
					"localhost2137-bot",
					"Grace",
				]);
				await expect(readUserNames(second.slack.connection)).resolves.toEqual([
					"localhost2137-bot",
				]);
			} finally {
				await second.destroy();
			}
		} finally {
			await first.destroy();
		}
	} finally {
		await runtime.close();
	}
});

async function readUserNames(
	connection: Readonly<{ apiUrl: string; botToken: string }>,
): Promise<string[]> {
	const response = await fetch(new URL("users.list", connection.apiUrl), {
		headers: { authorization: `Bearer ${connection.botToken}` },
	});
	const payload = (await response.json()) as {
		members: Array<{ name: string }>;
		ok: true;
	};
	expect(response.status).toBe(200);
	expect(payload.ok).toBe(true);
	return payload.members.map(({ name }) => name);
}
