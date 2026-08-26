import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const clean = spawnSync(pnpmExecutable, ["exec", "tsc", "-b", "--clean"], {
	cwd: repositoryRoot,
	stdio: "inherit",
});
if (clean.error) throw clean.error;
if (clean.status !== 0) {
	throw new Error(`TypeScript build clean failed with exit code ${clean.status ?? "unknown"}.`);
}

const outputDirectories = [
	join(repositoryRoot, "apps/docs/.react-router"),
	join(repositoryRoot, "apps/docs/.next"),
	join(repositoryRoot, "apps/docs/.source"),
	join(repositoryRoot, "apps/docs/build"),
	join(repositoryRoot, "packages/localhost2137/dist"),
	join(repositoryRoot, "packages/plugin-testkit/dist"),
	join(repositoryRoot, "plugins/slack/dist"),
	join(repositoryRoot, "plugins/stripe/dist"),
];
await Promise.all(
	outputDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
);
