import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import type { CliOption, OperationMetadata } from "../config/schema-metadata.js";
import { toCliName } from "../config/schema-metadata.js";
import type { CliServiceDescription } from "./service-description.js";

const RESERVED_OPERATION_FLAGS = new Set(["--help", "--input-json", "--instance", "--json"]);

export interface DynamicExecIo {
	writeError(value: string): void;
	writeOutput(value: string): void;
}

interface DynamicOperationInvocation {
	readonly input: Readonly<Record<string, unknown>>;
	readonly instanceId: string;
	readonly json: boolean;
	readonly operationKey: string;
	readonly serviceKey: string;
}

export interface DynamicExecResult {
	readonly exitCode: 0 | 2;
	readonly invocation?: DynamicOperationInvocation;
}

/** Builds a fresh Commander tree from server-provided, Phase 1-owned metadata. */
export async function parseDynamicExecCommand(
	service: CliServiceDescription,
	arguments_: readonly string[],
	input: Readonly<{ defaultInstance: string; io: DynamicExecIo }>,
): Promise<DynamicExecResult> {
	let invocation: DynamicOperationInvocation | undefined;
	let wroteError = false;
	const program = command({
		writeError(value) {
			wroteError = true;
			input.io.writeError(value);
		},
		writeOutput: input.io.writeOutput,
	})
		.name(`localhost exec ${service.name}`)
		.description(service.description)
		.showHelpAfterError()
		.action(() => program.outputHelp());

	for (const [operationKey, metadata] of Object.entries(service.operationMetadata)) {
		const operation = program.command(toCliName(operationKey)).description(metadata.description);
		operation.option("--instance <id>", "target instance", input.defaultInstance);
		operation.option("--json", "print only valid JSON");
		const compiled = addInputOptions(operation, metadata);
		operation.action((_options: unknown, actionCommand: Command) => {
			invocation = Object.freeze({
				input: readOperationInput(actionCommand, compiled),
				instanceId: String(actionCommand.getOptionValue("instance")),
				json: actionCommand.getOptionValue("json") === true,
				operationKey,
				serviceKey: service.name,
			});
		});
	}

	program.addHelpText("after", serviceOperationSummary(service.operationMetadata));
	try {
		await program.parseAsync([...arguments_], { from: "user" });
		return Object.freeze({ exitCode: 0, ...(invocation ? { invocation } : {}) });
	} catch (cause) {
		if (cause instanceof CommanderError) {
			if (cause.exitCode !== 0 && !wroteError) input.io.writeError(`error: ${cause.message}\n`);
			return Object.freeze({ exitCode: cause.exitCode === 0 ? 0 : 2 });
		}
		throw cause;
	}
}

interface CompiledInput {
	readonly fallbackReason?: string;
	readonly metadata: readonly Readonly<{ cli: CliOption; option: Option }>[];
}

function addInputOptions(command: Command, metadata: OperationMetadata): CompiledInput {
	const fallbackReason = fallback(metadata);
	const compiled: Array<Readonly<{ cli: CliOption; option: Option }>> = [];
	command.addOption(
		new Option("--input-json <json>", "provide the complete operation input as JSON"),
	);
	if (fallbackReason) {
		command.addHelpText("after", `\nJSON input required: ${fallbackReason}\n`);
		return Object.freeze({ fallbackReason, metadata: Object.freeze(compiled) });
	}
	if (metadata.cli.kind !== "flags") {
		throw new TypeError("Generated CLI metadata fallback state is inconsistent.");
	}
	for (const cli of metadata.cli.options) {
		const option = createInputOption(cli);
		command.addOption(option);
		compiled.push(Object.freeze({ cli, option }));
	}
	return Object.freeze({ metadata: Object.freeze(compiled) });
}

function fallback(metadata: OperationMetadata): string | undefined {
	if (metadata.cli.kind === "json") return metadata.cli.reason;
	const reserved = metadata.cli.options.find((option) => RESERVED_OPERATION_FLAGS.has(option.flag));
	if (reserved) return `Field "${reserved.name}" collides with runtime option ${reserved.flag}.`;
	const repeatedBoolean = metadata.cli.options.find(
		(option) => option.repeated && option.type === "boolean",
	);
	return repeatedBoolean
		? `Repeated boolean field "${repeatedBoolean.name}" requires JSON input.`
		: undefined;
}

function createInputOption(cli: CliOption): Option {
	const valuePlaceholder = cli.type === "boolean" ? "[boolean]" : `<${cli.type}>`;
	const flags = cli.repeated ? `${cli.flag} <${cli.type}>` : `${cli.flag} ${valuePlaceholder}`;
	const option = new Option(flags, optionDescription(cli));
	if (cli.required && cli.default === undefined) option.makeOptionMandatory();
	if (cli.type === "boolean") option.preset("true");
	if (cli.repeated) {
		option
			.default([])
			.argParser((raw: string, previous: unknown) => [
				...(Array.isArray(previous) ? previous : []),
				parseScalar(raw, cli),
			]);
	} else {
		option.argParser((raw) => parseScalar(raw, cli));
	}
	return option;
}

function optionDescription(option: CliOption): string {
	const details = [
		option.description,
		option.enum ? `allowed: ${option.enum.map(formatScalar).join(", ")}` : undefined,
		option.default === undefined ? undefined : `default: ${JSON.stringify(option.default)}`,
		option.examples ? `examples: ${option.examples.map(formatScalar).join(", ")}` : undefined,
	].filter((value): value is string => value !== undefined);
	return details.join("; ") || `set ${option.name}`;
}

function parseScalar(raw: string, option: CliOption): boolean | number | string {
	let value: boolean | number | string;
	switch (option.type) {
		case "boolean":
			if (raw !== "true" && raw !== "false") {
				throw new InvalidArgumentError(`Expected true or false for ${option.flag}.`);
			}
			value = raw === "true";
			break;
		case "integer":
			if (!/^-?(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
				throw new InvalidArgumentError(`Expected a safe integer for ${option.flag}.`);
			}
			value = Number(raw);
			break;
		case "number":
			value = Number(raw);
			if (raw.trim() === "" || !Number.isFinite(value)) {
				throw new InvalidArgumentError(`Expected a finite number for ${option.flag}.`);
			}
			break;
		case "string":
			value = raw;
			break;
	}
	if (option.enum && !option.enum.some((candidate) => Object.is(candidate, value))) {
		throw new InvalidArgumentError(
			`Expected one of ${option.enum.map(formatScalar).join(", ")} for ${option.flag}.`,
		);
	}
	return value;
}

function readOperationInput(
	command: Command,
	compiled: CompiledInput,
): Readonly<Record<string, unknown>> {
	const rawJson = command.getOptionValue("inputJson");
	const usedFlags = compiled.metadata.filter(
		({ option }) => command.getOptionValueSource(option.attributeName()) === "cli",
	);
	if (rawJson !== undefined && usedFlags.length > 0) {
		throw new InvalidArgumentError("--input-json cannot be combined with generated input flags.");
	}
	if (rawJson !== undefined) return parseInputJson(rawJson);
	if (compiled.fallbackReason) {
		throw new InvalidArgumentError("This operation requires --input-json <json>.");
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const { cli, option } of usedFlags) {
		defineEntry(result, cli.name, command.getOptionValue(option.attributeName()));
	}
	return Object.freeze(result);
}

function parseInputJson(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "string") throw new InvalidArgumentError("--input-json requires JSON text.");
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		throw new InvalidArgumentError("--input-json must contain valid JSON.");
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		throw new InvalidArgumentError("--input-json must contain a JSON object.");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function serviceOperationSummary(operations: Readonly<Record<string, OperationMetadata>>): string {
	const lines = Object.entries(operations).map(
		([key, operation]) => `  ${toCliName(key).padEnd(20)} ${operation.description}`,
	);
	return lines.length === 0
		? "\nNo operations are configured.\n"
		: `\nOperations:\n${lines.join("\n")}\n`;
}

function command(io: DynamicExecIo): Command {
	return new Command().exitOverride().configureOutput({
		outputError: (value, write) => write(value),
		writeErr: io.writeError,
		writeOut: io.writeOutput,
	});
}

function formatScalar(value: boolean | number | string | null): string {
	return JSON.stringify(value);
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}
