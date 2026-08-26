import { createServer } from "node:net";
import { defineConfig } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { slack } from "@localhost2137/slack";
import { buildPingPongBot, type PingPongBot } from "../src/bot.js";

const runtimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];
const bots: PingPongBot[] = [];

afterEach(async () => {
	await Promise.all(bots.splice(0).map((bot) => bot.stop()));
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("official Slack Bolt ping-pong bot", () => {
	it("receives ping and posts pong without Slack credentials or a workspace", async () => {
		const botPort = await availablePort();
		const config = defineConfig({
			services: {
				slack: slack({
					config: {
						botToken: "xoxb-local-ping-pong",
						eventsUrl: `http://127.0.0.1:${botPort}/slack/events`,
						signingSecret: "local-ping-pong-signing-secret",
						workspaceName: "Ping Pong Local",
					},
				}),
			},
		});
		const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
		runtimes.push(runtime);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "general" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });
			const bot = buildPingPongBot({
				apiUrl: instance.slack.connection.apiUrl,
				botToken: instance.slack.connection.botToken,
				port: botPort,
				signingSecret: instance.slack.connection.signingSecret,
			});
			bots.push(bot);
			await bot.start();

			await instance.slack.sendMessage({ channel: channel.id, from: ada.id, text: "ping" });
			await instance.idle();

			const messages = await instance.slack.listMessages({ channel: channel.id });
			expect(messages.map(({ text }) => text)).toEqual(["pong", "ping"]);
			expect(messages[0]).toMatchObject({ userId: "U000000" });
		} finally {
			await instance.destroy();
		}
	});
});

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Bot port reservation did not return an address.");
	}
	await new Promise<void>((resolve, reject) =>
		server.close((cause) => (cause ? reject(cause) : resolve())),
	);
	return address.port;
}
