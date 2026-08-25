import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

export async function sortedStorageEntries(path: string): Promise<readonly Dirent[]> {
	return (await readdir(path, { withFileTypes: true })).sort((left, right) =>
		compareCodeUnits(left.name, right.name),
	);
}

export async function sortedStorageDirectories(path: string): Promise<readonly Dirent[]> {
	return (await sortedStorageEntries(path)).filter((entry) => entry.isDirectory());
}

function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
