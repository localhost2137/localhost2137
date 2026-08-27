import { buildPingPongBot } from "./bot.js";

const bot = buildPingPongBot({
	apiUrl: requiredEnvironment("SLACK_API_URL"),
	botToken: requiredEnvironment("SLACK_BOT_TOKEN"),
	port: 3_000,
	signingSecret: requiredEnvironment("SLACK_SIGNING_SECRET"),
});

await bot.start();
process.stdout.write("bot: http://127.0.0.1:3000/slack/events\n");

for (const [signal, exitCode] of [
	["SIGHUP", 129],
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	process.once(signal, () => {
		void bot.stop().then(
			() => {
				process.exitCode = exitCode;
			},
			(cause: unknown) => {
				process.stderr.write(`bot shutdown failed: ${safeMessage(cause)}\n`);
				process.exitCode = 1;
			},
		);
	});
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}. Start this script with localhost run.`);
	return value;
}

function safeMessage(value: unknown): string {
	return value instanceof Error && value.message.trim() !== "" ? value.message : "unknown error";
}
