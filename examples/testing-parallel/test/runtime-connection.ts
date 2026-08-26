export interface WorkerRuntimeHarness {
	readonly barrier: Readonly<{
		readonly directory: string;
		readonly participants: number;
	}>;
	readonly connection: Readonly<{
		readonly token: string;
		readonly url: string;
	}>;
}

declare module "vitest" {
	export interface ProvidedContext {
		readonly localhost2137: WorkerRuntimeHarness;
	}
}
