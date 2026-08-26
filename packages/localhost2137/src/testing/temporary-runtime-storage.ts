import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRuntimeCleanupError } from "./test-runtime-errors.js";

type RemoveDirectory = (path: string) => Promise<void>;

export class TemporaryRuntimeStorage {
	readonly path: string;
	readonly #remove: RemoveDirectory;
	#removePromise: Promise<void> | undefined;

	private constructor(path: string, remove: RemoveDirectory) {
		this.path = path;
		this.#remove = remove;
	}

	static async create(
		input: Readonly<{
			makeDirectory?: () => Promise<string>;
			removeDirectory?: RemoveDirectory;
		}> = {},
	): Promise<TemporaryRuntimeStorage> {
		const makeDirectory =
			input.makeDirectory ?? (() => mkdtemp(join(tmpdir(), "localhost2137-test-runtime-")));
		const removeDirectory =
			input.removeDirectory ??
			((path: string) => rm(path, { force: true, recursive: true, maxRetries: 2 }));
		return new TemporaryRuntimeStorage(await makeDirectory(), removeDirectory);
	}

	remove(): Promise<void> {
		this.#removePromise ??= this.#remove(this.path).catch((cause: unknown) => {
			throw new TestRuntimeCleanupError(this.path, [cause]);
		});
		return this.#removePromise;
	}
}
