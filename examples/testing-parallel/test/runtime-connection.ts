export interface WorkerRuntimeConnection {
	readonly token: string;
	readonly url: string;
}

declare module "vitest" {
	export interface ProvidedContext {
		readonly localhost2137: WorkerRuntimeConnection;
	}
}
