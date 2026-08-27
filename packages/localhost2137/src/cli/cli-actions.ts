import type { CliServiceDescription } from "./service-description.js";

export interface CliDevOptions {
	readonly host?: "127.0.0.1" | "::1" | "localhost";
	readonly port?: number;
}

export interface CliProjectInitialization {
	readonly gitignore: "created" | "unchanged" | "updated";
}

export interface CliActions {
	advanceClock(instanceId: string, duration: string): Promise<unknown>;
	clockStatus(instanceId: string): Promise<unknown>;
	createInstance(id: string, seed: boolean): Promise<unknown>;
	describe(instanceId: string, serviceKey?: string): Promise<unknown>;
	describeService(instanceId: string, serviceKey: string): Promise<CliServiceDescription>;
	destroyInstance(id: string): Promise<void>;
	dev(options: CliDevOptions): Promise<void>;
	doctor(): Promise<unknown>;
	environment(instanceId: string, format: "dotenv" | "json"): Promise<string>;
	execute(
		input: Readonly<{
			input: Readonly<Record<string, unknown>>;
			instanceId: string;
			operationKey: string;
			serviceKey: string;
		}>,
	): Promise<unknown>;
	initProject(): Promise<CliProjectInitialization>;
	listInstances(): Promise<unknown>;
	logs(
		input: Readonly<{ instanceId: string; serviceKey?: string; tail: number }>,
	): Promise<unknown>;
	resetInstance(id: string, seed: boolean): Promise<unknown>;
	run(instanceId: string, command: readonly string[]): Promise<number>;
	seed(instanceId: string): Promise<void>;
}

export interface CliIo {
	writeError(value: string): void;
	writeOutput(value: string): void;
}
