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
process.exitCode = await runCliCommand({
	arguments: process.argv.slice(2),
	createActions: (bootstrap) =>
		createNodeCliActions({
			cwd: process.cwd(),
			inheritedEnv: process.env,
			io,
			...(bootstrap.configPath === undefined ? {} : { configPath: bootstrap.configPath }),
		}),
	defaultInstance,
	io,
});
