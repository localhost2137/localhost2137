import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { renderGeneratedDevEnvironment } from "../config/environment-rendering.js";
import { writeTextAtomically } from "./atomic-file.js";
import { storagePaths } from "./storage-paths.js";

/** Replaces only the runtime-owned generated environment file. */
export async function writeGeneratedDevEnvironment(
	storageRoot: string,
	environment: Readonly<Record<string, string>>,
): Promise<string> {
	const root = storagePaths(storageRoot).root;
	await mkdir(root, { recursive: true });
	const filePath = resolve(root, ".env");
	await writeTextAtomically(filePath, renderGeneratedDevEnvironment(environment), { mode: 0o600 });
	return filePath;
}
