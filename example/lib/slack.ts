import { definePlugin } from "localhost2137";
import { Hono } from "hono";
import * as z from "zod";

const api = new Hono();

// in our case, this will be server under route "localhost:2137/slack/health"
app.get('/health', c => c.json({ status: 'ok' }));

const Config = z.object({ 
  workspaceName: z.string(),
  botApiToken: z.string(),
});

export const slackPlugin = definePlugin({
	name: "slack", // default name/id
	api,
	configType: Config,
	createBaseStorage: async ({ storagePath }) => {
		// stuff like creating SQLite db instance and seeding it, or creating dirs for file storing
	},
	bootstrap: async ({ storagePath, config }) => {
		// stuff like e.g. read SQLite db, create new instance and assing to global varaible to make it available everywhere
		// or read user provided config
	}
});
