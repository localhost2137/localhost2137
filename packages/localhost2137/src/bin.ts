#!/usr/bin/env node
import { runCliCommand } from "./cli/command-program.js";
import { createNodeCliActions } from "./node/cli-runtime-actions.js";

const io = Object.freeze({
	writeError(value: string) {
		process.stderr.write(value);
	},
	writeOutput(value: string) {
		process.stdout.write(value);
	},
});
const configuredInstance = process.env.LOCALHOST_INSTANCE?.trim();
const defaultInstance = configuredInstance ? configuredInstance : "dev";
const actions = createNodeCliActions({
	cwd: process.cwd(),
	inheritedEnv: process.env,
	io,
});

process.exitCode = await runCliCommand({
	actions,
	arguments: process.argv.slice(2),
	defaultInstance,
	io,
});
