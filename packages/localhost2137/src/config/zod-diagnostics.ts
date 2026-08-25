import type { z } from "zod";
import type { Schema } from "../authoring/operation.js";
import { type ConfigIssue, issuePath, receivedType } from "./config-error.js";

export type SchemaParseResult =
	| Readonly<{ data: unknown; success: true }>
	| Readonly<{ cause?: unknown; issues: readonly RelativeConfigIssue[]; success: false }>;

export interface RelativeConfigIssue extends Omit<ConfigIssue, "path"> {
	readonly relativePath: readonly PropertyKey[];
}

export function parsePluginSchema(schema: Schema, value: unknown): SchemaParseResult {
	try {
		const result = schema.safeParse(value);
		if (result.success) {
			return { data: result.data, success: true };
		}
		return {
			issues: result.error.issues.map((issue) => {
				const expected = expectedFromZodIssue(issue);
				return Object.freeze({
					code: issue.code,
					...(expected ? { expected } : {}),
					message: issue.message,
					received: receivedType(valueAtPath(value, issue.path)),
					relativePath: Object.freeze([...issue.path]),
				});
			}),
			success: false,
		};
	} catch (cause) {
		return {
			cause,
			issues: [
				Object.freeze({
					code: "invalid_schema",
					expected: "a Zod schema",
					message: "Plugin schema could not parse the configured value.",
					received: receivedType(value),
					relativePath: Object.freeze([]),
				}),
			],
			success: false,
		};
	}
}

export function absoluteZodIssue(issue: z.core.$ZodIssue, value: unknown): ConfigIssue {
	const expected = expectedFromZodIssue(issue);
	return Object.freeze({
		code: issue.code,
		...(expected ? { expected } : {}),
		message: issue.message,
		path: issuePath(issue.path),
		received: receivedType(valueAtPath(value, issue.path)),
	});
}

function expectedFromZodIssue(issue: z.core.$ZodIssue): string | undefined {
	if ("expected" in issue && typeof issue.expected === "string") {
		return issue.expected;
	}
	if ("format" in issue && typeof issue.format === "string") {
		return issue.format;
	}
	return undefined;
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
	let current = value;
	for (const segment of path) {
		if (!isIndexable(current) || !(segment in current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function isIndexable(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null;
}
