import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "localhost2137-slack-pack-"));
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

try {
	const packed = spawnSync(
		pnpmExecutable,
		["pack", "--json", "--pack-destination", temporaryDirectory],
		{ cwd: packageDirectory, encoding: "utf8" },
	);
	if (packed.error) throw packed.error;
	if (packed.status !== 0) {
		throw new Error(`pnpm pack failed: ${packed.stderr.trim() || "unknown error"}`);
	}
	const inventory = JSON.parse(packed.stdout);
	if (!Array.isArray(inventory.files)) throw new Error("pnpm pack returned no file inventory.");
	const paths = new Set(inventory.files.map((file) => file.path));
	requirePath(paths, "assets/ui/index.html");
	requirePath(paths, "THIRD_PARTY_NOTICES.md");
	requireExtension(paths, ".js");
	requireExtension(paths, ".css");
	requireFont(paths);

	const license = await readFile(join(packageDirectory, "THIRD_PARTY_NOTICES.md"), "utf8");
	if (!license.includes("SIL OPEN FONT LICENSE Version 1.1") || !license.includes("Lato")) {
		throw new Error("Packed Lato assets are missing their readable OFL-1.1 notice.");
	}
	process.stdout.write(
		`Slack dashboard pack contains ${String(paths.size)} files and its font license.\n`,
	);
} finally {
	await rm(temporaryDirectory, { force: true, recursive: true });
}

function requirePath(paths, path) {
	if (!paths.has(path)) throw new Error(`Slack package is missing ${path}.`);
}

function requireExtension(paths, extension) {
	if (
		![...paths].some((path) => path.startsWith("assets/ui/assets/") && path.endsWith(extension))
	) {
		throw new Error(`Slack package contains no dashboard ${extension} asset.`);
	}
}

function requireFont(paths) {
	if (
		![...paths].some(
			(path) =>
				path.startsWith("assets/ui/assets/") && (path.endsWith(".woff") || path.endsWith(".woff2")),
		)
	) {
		throw new Error("Slack package contains no bundled dashboard font asset.");
	}
}
