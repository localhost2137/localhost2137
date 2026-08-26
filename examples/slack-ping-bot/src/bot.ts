import { App, LogLevel } from "@slack/bolt";

export interface PingPongBotOptions {
	readonly apiUrl: string;
	readonly botToken: string;
	readonly port: number;
	readonly signingSecret: string;
}

export interface PingPongBot {
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** Builds an ordinary Bolt app wired only through localhost2137 connection metadata. */
export function buildPingPongBot(options: PingPongBotOptions): PingPongBot {
	const app = new App({
		clientOptions: { slackApiUrl: options.apiUrl },
		endpoints: "/slack/events",
		logLevel: LogLevel.ERROR,
		signingSecret: options.signingSecret,
		token: options.botToken,
	});
	app.message(/^ping$/, async ({ say }) => {
		await say("pong");
	});
	let phase: "new" | "running" | "stopped" = "new";
	return Object.freeze({
		async start() {
			if (phase !== "new") throw new Error("Ping-pong bot may be started exactly once.");
			await app.start({ host: "127.0.0.1", port: options.port });
			phase = "running";
		},
		async stop() {
			if (phase === "stopped") return;
			if (phase === "running") await app.stop();
			phase = "stopped";
		},
	});
}
