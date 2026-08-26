import { ownControlToken } from "../control/control-client.js";
import {
	ownRuntimeDescriptor,
	type RuntimeDescriptor,
	RuntimeDescriptorValidationError,
} from "../control/runtime-descriptor.js";
import { readBoundedRegularFile } from "./bounded-regular-file.js";

const DESCRIPTOR_LIMIT_BYTES = 16 * 1024;
const TOKEN_LIMIT_BYTES = 1024;

export async function readRuntimeDescriptorFile(path: string): Promise<RuntimeDescriptor> {
	const text = await readBoundedText(path, DESCRIPTOR_LIMIT_BYTES);
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (cause) {
		throw new RuntimeDescriptorValidationError(
			"MALFORMED_DESCRIPTOR",
			"$",
			`Runtime descriptor must contain valid JSON (${cause instanceof Error ? cause.name : "parse error"}).`,
		);
	}
	return ownRuntimeDescriptor(decoded);
}

export async function readRuntimeTokenFile(path: string): Promise<string> {
	const value = await readBoundedText(path, TOKEN_LIMIT_BYTES);
	const withoutTerminator = value.endsWith("\r\n")
		? value.slice(0, -2)
		: value.endsWith("\n")
			? value.slice(0, -1)
			: value;
	return ownControlToken(withoutTerminator);
}

async function readBoundedText(path: string, limitBytes: number): Promise<string> {
	return new TextDecoder("utf-8", { fatal: true }).decode(
		await readBoundedRegularFile(path, limitBytes),
	);
}
