import { watch } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BARRIER_TIMEOUT_MS = 10_000;

export async function arriveAtBarrier(
	directory: string,
	participant: string,
	expectedParticipants: number,
): Promise<void> {
	if (!/^[a-z][a-z0-9-]*$/.test(participant)) {
		throw new TypeError(`Invalid barrier participant ${participant}.`);
	}
	await writeFile(join(directory, `${participant}.arrived`), "", { flag: "wx" });
	await waitForArrivals(directory, expectedParticipants);
}

function waitForArrivals(directory: string, expectedParticipants: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const watcher = watch(directory);
		let checking = false;
		let checkAgain = false;
		let settled = false;
		const timeout = setTimeout(
			() => finish(new Error(`Barrier timed out waiting for ${expectedParticipants} workers.`)),
			BARRIER_TIMEOUT_MS,
		);

		const finish = (failure?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			watcher.close();
			if (failure === undefined) resolve();
			else reject(failure);
		};
		const check = (): void => {
			if (settled) return;
			if (checking) {
				checkAgain = true;
				return;
			}
			checking = true;
			void readdir(directory)
				.then(
					(entries) => {
						if (
							entries.filter((entry) => entry.endsWith(".arrived")).length === expectedParticipants
						) {
							finish();
						}
					},
					(cause: unknown) => finish(cause),
				)
				.finally(() => {
					checking = false;
					if (checkAgain) {
						checkAgain = false;
						check();
					}
				});
		};

		watcher.on("change", check);
		watcher.on("error", finish);
		check();
	});
}
