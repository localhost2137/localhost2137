import { definePlugin } from "localhost2137";
import { Hono } from "hono";
import * as z from "zod";

const api = new Hono();

// in our case, this will be server under route "localhost:2137/slack/health"
app.get('/health', c => c.json({ status: checkDbStatus(c.vars.ctx.db) })); // this is sample way of getting global state, although I don't remember hono syntax, so it migh not be ctx.vars ;)

const Config = z.object({ 
  workspaceName: z.string(),
  botApiToken: z.string(),
});

export const slackPlugin = definePlugin({
	name: "slack", // default name/id
	api,
	configType: Config,
	createNewInstance: async ({ storagePath }) => {
		// stuff like creating SQLite db instance and seeding it, or creating dirs for file storing
		await createNewDb(storagePath + "/local.db");
	},
	bootstrap: async ({ storagePath, config, ctx }) => {
		// stuff like e.g. read SQLite db, create new instance and assing to global varaible to make it available everywhere
		// or read user provided config
		const db = await loadDb(storagePath + "/local.db");

		// 2 options, didn't decide yet
		// fisrt - assign to context:
		ctx.state.db = db;

		// second, just return and localhost assigns it to ctx.state:
		return { db };
	}
});
