export class TestRuntimeClosedError extends Error {
	constructor() {
		super("The localhost2137 test runtime is closing or already closed.");
		this.name = "TestRuntimeClosedError";
	}
}

export class TestInstanceClosedError extends Error {
	readonly instanceId: string;

	constructor(instanceId: string) {
		super(`Test instance "${instanceId}" is being destroyed or has already been destroyed.`);
		this.name = "TestInstanceClosedError";
		this.instanceId = instanceId;
	}
}

export class TestInstanceBusyError extends Error {
	readonly instanceId: string;

	constructor(instanceId: string) {
		super(`Test instance "${instanceId}" already has a lifecycle mutation in progress.`);
		this.name = "TestInstanceBusyError";
		this.instanceId = instanceId;
	}
}

export class TestRuntimeCleanupError extends AggregateError {
	readonly retainedStoragePath: string;

	constructor(retainedStoragePath: string, causes: readonly unknown[]) {
		super(
			causes,
			`Test runtime cleanup failed; temporary storage was retained at ${retainedStoragePath}.`,
		);
		this.name = "TestRuntimeCleanupError";
		this.retainedStoragePath = retainedStoragePath;
	}
}
