/**
 * Minimal localhost2137 config — the "hello world".
 *
 * Decided shape: a KEYED services map + explicit factory envelope.
 *   key      → stable identity: route /slack, CLI selector, storage
 *              namespace, localhost.slack lookup (all derived)
 *   config   → plugin-defined, validated against the plugin's schema
 *   seed     → optional declarative world data, applied only when requested
 *
 * Credentials here are NOT secrets — they are part of the simulated world.
 */
import { defineConfig } from "localhost2137";
import { slack } from "@localhost2137/slack";

export default defineConfig({
	host: "127.0.0.1", // loopback only; the control plane is privileged
	port: 2137,

	services: {
		slack: slack({
			config: {
				workspaceName: "Acme Dev",
				botToken: "xoxb-local-acme",
				signingSecret: "local-signing-secret",
			},
		}),
	},
});

/*
 * Boot & use:
 *
 *   $ localhost dev
 *   # → slack ready at http://127.0.0.1:2137/dev/slack   (instance "dev" is the default)
 *   # → .localhost2137/.env written (SLACK_BASE_URL, SLACK_BOT_TOKEN, …)
 *
 *   $ localhost exec slack create-user --name Alice --json
 *   {"id":"U000001","name":"Alice","admin":false}
 */
