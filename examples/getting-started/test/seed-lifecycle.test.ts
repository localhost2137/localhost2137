import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "./fixtures/seeding-config.js";

it("applies plugin seed before scenario seed and keeps reset explicit", async () => {
	const runtime = await startRuntime();

	try {
		const instance = await runtime.createInstance();
		try {
			await expect(readUserNames(instance.slack.connection)).resolves.toEqual([
				"localhost2137-bot",
			]);
			await expect(instance.slack.listMessages({ channel: "general" })).rejects.toMatchObject({
				code: "SLACK_CHANNEL_NOT_FOUND",
			});

			await instance.seed();
			await expectSeededBaseline(instance);
			await expect(instance.seed()).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });

			await instance.reset();
			await expect(readUserNames(instance.slack.connection)).resolves.toEqual([
				"localhost2137-bot",
			]);

			await instance.reset({ seed: true });
			await expectSeededBaseline(instance);
		} finally {
			await instance.destroy();
		}
	} finally {
		await runtime.close();
	}
});

function startRuntime() {
	return createTestRuntime({ config, port: 0, storage: "temporary" });
}

type SeedingRuntime = Awaited<ReturnType<typeof startRuntime>>;
type SeedingInstance = Awaited<ReturnType<SeedingRuntime["createInstance"]>>;

async function expectSeededBaseline(instance: SeedingInstance): Promise<void> {
	await expect(readUserNames(instance.slack.connection)).resolves.toEqual([
		"localhost2137-bot",
		"Ada",
	]);
	await expect(instance.slack.listMessages({ channel: "general" })).resolves.toMatchObject([
		{ text: "baseline ready", userId: "U_ADA" },
	]);
}

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
