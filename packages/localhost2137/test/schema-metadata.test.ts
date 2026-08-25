import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation } from "../src/authoring/operation.js";
import {
	createOperationMetadata,
	createSchemaMetadata,
	type SchemaIntrospectionError,
} from "../src/config/schema-metadata.js";

const operation = defineOperation<"metadata", object, object>();

describe("operation schema metadata", () => {
	it("preserves supported Zod metadata and compiles a constrained flag model", () => {
		const metadata = createOperationMetadata(
			operation({
				description: "Create a fixture",
				input: z.object({
					admin: z.boolean().default(false).meta({ description: "Grant administrator access" }),
					count: z.int().optional(),
					name: z.string().meta({ description: "Display name", examples: ["Alice"] }),
					roles: z.array(z.enum(["owner", "member"])).optional(),
				}),
				output: z.object({ id: z.string() }),
				run: (_context, input) => ({ id: input.name }),
			}),
		);

		expect(metadata).toMatchInlineSnapshot(`
			{
			  "cli": {
			    "kind": "flags",
			    "options": [
			      {
			        "default": false,
			        "description": "Grant administrator access",
			        "flag": "--admin",
			        "name": "admin",
			        "repeated": false,
			        "required": false,
			        "type": "boolean",
			      },
			      {
			        "flag": "--count",
			        "name": "count",
			        "repeated": false,
			        "required": false,
			        "type": "integer",
			      },
			      {
			        "description": "Display name",
			        "examples": [
			          "Alice",
			        ],
			        "flag": "--name",
			        "name": "name",
			        "repeated": false,
			        "required": true,
			        "type": "string",
			      },
			      {
			        "enum": [
			          "owner",
			          "member",
			        ],
			        "flag": "--roles",
			        "name": "roles",
			        "repeated": true,
			        "required": false,
			        "type": "string",
			      },
			    ],
			  },
			  "description": "Create a fixture",
			  "input": {
			    "$schema": "https://json-schema.org/draft/2020-12/schema",
			    "properties": {
			      "admin": {
			        "default": false,
			        "description": "Grant administrator access",
			        "type": "boolean",
			      },
			      "count": {
			        "maximum": 9007199254740991,
			        "minimum": -9007199254740991,
			        "type": "integer",
			      },
			      "name": {
			        "description": "Display name",
			        "examples": [
			          "Alice",
			        ],
			        "type": "string",
			      },
			      "roles": {
			        "items": {
			          "enum": [
			            "owner",
			            "member",
			          ],
			          "type": "string",
			        },
			        "type": "array",
			      },
			    },
			    "required": [
			      "name",
			    ],
			    "type": "object",
			  },
			  "output": {
			    "$schema": "https://json-schema.org/draft/2020-12/schema",
			    "additionalProperties": false,
			    "properties": {
			      "id": {
			        "type": "string",
			      },
			    },
			    "required": [
			      "id",
			    ],
			    "type": "object",
			  },
			}
		`);
		expect(Object.isFrozen(metadata.input.properties)).toBe(true);
	});

	it.each([
		[
			"nested field",
			z.object({ profile: z.object({ name: z.string() }) }),
			'Field "profile" is not a supported scalar.',
		],
		[
			"union field",
			z.object({ identity: z.union([z.string(), z.number()]) }),
			'Field "identity" requires nested, referenced, or union JSON input.',
		],
	])("uses explicit JSON input fallback for an unsupported %s", (_name, input, reason) => {
		const metadata = createOperationMetadata(
			operation({
				description: "Unsupported fixture",
				input,
				output: z.object({ ok: z.boolean() }),
				run: () => ({ ok: true }),
			}),
		);
		expect(metadata.cli).toEqual({ kind: "json", reason });
	});

	it("reports supported-API conversion failures with the schema role", () => {
		expect(() => createSchemaMetadata(z.date(), "config")).toThrowError(
			expect.objectContaining<Partial<SchemaIntrospectionError>>({
				message: "Could not convert config schema to JSON Schema.",
				schemaRole: "config",
			}),
		);
	});
});
