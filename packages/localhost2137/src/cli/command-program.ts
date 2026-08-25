import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import type { CliActions, CliIo } from "./cli-actions.js";
import { CliUsageError, classifyCliFailure } from "./cli-errors.js";
import { parseDynamicExecCommand } from "./dynamic-exec-command.js";

export interface RunCliInput {
	readonly actions: CliActions;
	readonly arguments: readonly string[];
	readonly defaultInstance: string;
	readonly io: CliIo;
}

/** Parses one invocation with fresh Commander state and returns, but never exits, the process. */
export async function runCliCommand(input: RunCliInput): Promise<number> {
	try {
		if (input.arguments[0] === "exec") return await runExec(input);
		return await runStatic(input);
	} catch (cause) {
		if (cause instanceof CommanderError) return cause.exitCode === 0 ? 0 : 2;
		const failure = classifyCliFailure(cause);
		input.io.writeError(`error: ${failure.message}\n`);
		return failure.exitCode;
	}
}

async function runExec(input: RunCliInput): Promise<number> {
	const serviceKey = input.arguments[1];
	if (serviceKey === undefined || serviceKey === "--help" || serviceKey === "-h") {
		input.io.writeOutput(
			"Usage: localhost exec <service> [operation] [options]\n\nDiscover service operations with: localhost exec <service> --help\n",
		);
		return serviceKey === undefined ? 2 : 0;
	}
	if (serviceKey.startsWith("-")) throw new CliUsageError("Expected a service name.");
	const operationArguments = input.arguments.slice(2);
	const instanceId = instanceFromArguments(operationArguments, input.defaultInstance);
	const service = await input.actions.describeService(instanceId, serviceKey);
	const parsed = await parseDynamicExecCommand(service, operationArguments, {
		defaultInstance: input.defaultInstance,
		io: input.io,
	});
	if (!parsed.invocation) return parsed.exitCode;
	const data = await input.actions.execute(parsed.invocation);
	writeData(input.io, data, parsed.invocation.json);
	return 0;
}

async function runStatic(input: RunCliInput): Promise<number> {
	let commandExitCode = 0;
	const program = baseCommand(input.io)
		.name("localhost")
		.description("Local runtime for stateful external-service emulators")
		.enablePositionalOptions()
		.showHelpAfterError()
		.action(() => program.outputHelp());

	program
		.command("dev")
		.description("start the project runtime")
		.option("--config <path>", "explicit localhost config path")
		.addOption(
			new Option("--host <host>", "loopback host").choices(["127.0.0.1", "localhost", "::1"]),
		)
		.option("--port <port>", "loopback port", parsePort)
		.action(async (options: Readonly<{ config?: string; host?: CliDevHost; port?: number }>) => {
			await input.actions.dev({
				...(options.config === undefined ? {} : { configPath: options.config }),
				...(options.host === undefined ? {} : { host: options.host }),
				...(options.port === undefined ? {} : { port: options.port }),
			});
		});

	program
		.command("describe")
		.description("describe configured services and operations")
		.argument("[service]")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.option("--json", "print only valid JSON")
		.action(async (service: string | undefined, options: InstanceJsonOptions) => {
			writeData(
				input.io,
				await input.actions.describe(options.instance, service),
				options.json === true,
			);
		});

	const instance = program.command("instance").description("manage isolated worlds");
	instance
		.command("create")
		.argument("<id>")
		.option("--seed", "seed after creation")
		.action(async (id: string, options: Readonly<{ seed?: boolean }>) => {
			await input.actions.createInstance(id, options.seed === true);
			input.io.writeOutput(`created ${id}${options.seed ? " (seeded)" : ""}\n`);
		});
	instance
		.command("list")
		.option("--json", "print only valid JSON")
		.action(async (options: Readonly<{ json?: boolean }>) => {
			writeData(input.io, await input.actions.listInstances(), options.json === true);
		});
	instance
		.command("reset")
		.argument("<id>")
		.option("--seed", "seed after reset")
		.action(async (id: string, options: Readonly<{ seed?: boolean }>) => {
			await input.actions.resetInstance(id, options.seed === true);
			input.io.writeOutput(`reset ${id}${options.seed ? " (seeded)" : ""}\n`);
		});
	instance
		.command("destroy")
		.argument("<id>")
		.action(async (id: string) => {
			await input.actions.destroyInstance(id);
			input.io.writeOutput(`destroyed ${id}\n`);
		});

	program
		.command("seed")
		.description("apply configured plugin and scenario seed data")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.action(async (options: Readonly<{ instance: string }>) => {
			await input.actions.seed(options.instance);
			input.io.writeOutput(`seeded ${options.instance}\n`);
		});

	program
		.command("env")
		.description("render app-facing connection environment")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.addOption(
			new Option("--format <format>", "environment format")
				.choices(["dotenv", "json"])
				.default("dotenv"),
		)
		.action(async (options: Readonly<{ format: "dotenv" | "json"; instance: string }>) => {
			input.io.writeOutput(await input.actions.environment(options.instance, options.format));
		});

	program
		.command("run")
		.description("run a command with app-facing connection environment")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.argument("<command...>")
		.allowUnknownOption()
		.passThroughOptions()
		.action(async (command: string[], options: Readonly<{ instance: string }>) => {
			commandExitCode = await input.actions.run(options.instance, Object.freeze([...command]));
		});

	program
		.command("logs")
		.description("inspect bounded runtime logs")
		.argument("[service]")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.option("--tail <count>", "maximum entries", parseTail, 50)
		.option("--json", "print only valid JSON")
		.action(
			async (
				service: string | undefined,
				options: Readonly<{ instance: string; json?: boolean; tail: number }>,
			) => {
				const data = await input.actions.logs({
					instanceId: options.instance,
					...(service === undefined ? {} : { serviceKey: service }),
					tail: options.tail,
				});
				writeData(input.io, data, options.json === true);
			},
		);

	program
		.command("clock")
		.description("inspect instance time")
		.command("status")
		.option("--instance <id>", "target instance", input.defaultInstance)
		.option("--json", "print only valid JSON")
		.action(async (options: InstanceJsonOptions) => {
			const data = await input.actions.clockStatus(options.instance);
			writeData(input.io, data, options.json === true);
		});

	program
		.command("doctor")
		.description("diagnose project runtime discovery and storage")
		.option("--json", "print only valid JSON")
		.action(async (options: Readonly<{ json?: boolean }>) => {
			writeData(input.io, await input.actions.doctor(), options.json === true);
		});

	await program.parseAsync([...input.arguments], { from: "user" });
	return commandExitCode;
}

type CliDevHost = "127.0.0.1" | "::1" | "localhost";
type InstanceJsonOptions = Readonly<{ instance: string; json?: boolean }>;

function baseCommand(io: CliIo): Command {
	return new Command().exitOverride().configureOutput({
		outputError: (value, write) => write(value),
		writeErr: io.writeError,
		writeOut: io.writeOutput,
	});
}

function writeData(io: CliIo, data: unknown, json: boolean): void {
	if (json) {
		io.writeOutput(`${JSON.stringify(data)}\n`);
		return;
	}
	if (typeof data === "string") {
		io.writeOutput(`${data}\n`);
		return;
	}
	io.writeOutput(`${JSON.stringify(data, undefined, 2)}\n`);
}

function instanceFromArguments(arguments_: readonly string[], fallback: string): string {
	let result = fallback;
	let found = false;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--instance") {
			if (found) throw new CliUsageError("--instance may be specified only once.");
			const value = arguments_[index + 1];
			if (!value || value.startsWith("-")) {
				throw new CliUsageError("--instance requires an instance id.");
			}
			result = value;
			found = true;
			index += 1;
		} else if (argument?.startsWith("--instance=")) {
			if (found) throw new CliUsageError("--instance may be specified only once.");
			result = argument.slice("--instance=".length);
			if (result === "") throw new CliUsageError("--instance requires an instance id.");
			found = true;
		}
	}
	return result;
}

function parsePort(value: string): number {
	if (!/^\d+$/.test(value)) throw new InvalidArgumentError("Port must be an integer.");
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new InvalidArgumentError("Port must be from 1 to 65535.");
	}
	return port;
}

function parseTail(value: string): number {
	if (!/^\d+$/.test(value)) throw new InvalidArgumentError("Tail must be an integer.");
	const tail = Number(value);
	if (!Number.isSafeInteger(tail) || tail < 0 || tail > 1_000) {
		throw new InvalidArgumentError("Tail must be from 0 to 1000.");
	}
	return tail;
}
