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

	it.each(["", "--bad", " leading ", "invalid/name"])(
		"uses JSON input for a property name that cannot form a safe flag: %j",
		(propertyName) => {
			const metadata = createOperationMetadata(
				operation({
					description: "Unsafe flag fixture",
					input: z.object({ [propertyName]: z.string() }),
					output: z.object({ ok: z.boolean() }),
					run: () => ({ ok: true }),
				}),
			);
			expect(metadata.cli).toEqual({
				kind: "json",
				reason: `Field ${JSON.stringify(propertyName)} cannot map to a safe CLI flag.`,
			});
		},
	);

	it("preserves a computed __proto__ field on a recursive root", () => {
		const recursive = z.object({
			["__proto__"]: z.string(),
			children: z.array(z.lazy(() => recursive)).optional(),
		});
		const metadata = createOperationMetadata(
			operation({
				description: "Prototype-shaped property fixture",
				input: recursive,
				output: z.object({ ok: z.boolean() }),
				run: () => ({ ok: true }),
			}),
		);
		const properties = metadata.input.properties;

		expect(Object.hasOwn(properties ?? {}, "__proto__")).toBe(true);
		expect(Reflect.get(properties ?? {}, "__proto__")).toEqual({ type: "string" });
		expect(metadata.input.required).toEqual(["__proto__"]);
		expect(Reflect.get(properties ?? {}, "children")).toMatchObject({
			items: { $ref: "#" },
			type: "array",
		});
		expect(metadata.cli.kind).toBe("json");
	});

	it("preserves prototype-shaped fields through nested arrays and reused nodes", () => {
		const leaf = z.object({ ["__proto__"]: z.boolean() });
		const metadata = createSchemaMetadata(
			z.object({ groups: z.array(leaf), reused: leaf }),
			"input",
			"input",
		);
		const rootProperties = metadata.properties;
		const arrayProperties = readProperty(
			readProperty(readProperty(rootProperties, "groups"), "items"),
			"properties",
		);
		const reusedProperties = readProperty(readProperty(rootProperties, "reused"), "properties");

		expect(isObject(arrayProperties)).toBe(true);
		expect(isObject(reusedProperties)).toBe(true);
		if (!isObject(arrayProperties) || !isObject(reusedProperties)) return;
		expect(Object.hasOwn(arrayProperties, "__proto__")).toBe(true);
		expect(Object.hasOwn(reusedProperties, "__proto__")).toBe(true);
		expect(Reflect.get(arrayProperties, "__proto__")).toEqual({ type: "boolean" });
		expect(Reflect.get(reusedProperties, "__proto__")).toEqual({ type: "boolean" });
	});

	it("restores a prototype-shaped field in a referenced definition", () => {
		const leaf = z.object({ ["__proto__"]: z.string() }).meta({ id: "Leaf" });
		const metadata = createOperationMetadata(
			operation({
				description: "Referenced prototype-shaped fixture",
				input: z.object({ leaf }),
				output: z.object({ ok: z.boolean() }),
				run: () => ({ ok: true }),
			}),
		);
		const leafDefinition = readProperty(readProperty(metadata.input, "$defs"), "Leaf");
		const properties = readProperty(leafDefinition, "properties");

		expect(isObject(properties)).toBe(true);
		if (!isObject(properties)) return;
		expect(Object.hasOwn(properties, "__proto__")).toBe(true);
		expect(Reflect.get(properties, "__proto__")).toEqual({ type: "string" });
		expect(readProperty(leafDefinition, "required")).toEqual(["__proto__"]);
		expect(readProperty(readProperty(metadata.input, "properties"), "leaf")).toEqual({
			$ref: "#/$defs/Leaf",
		});
		expect(metadata.cli.kind).toBe("json");
	});

	it("reports supported-API conversion failures with the schema role", () => {
		expect(() => createSchemaMetadata(z.date(), "config")).toThrowError(
			expect.objectContaining<Partial<SchemaIntrospectionError>>({
				message: "Could not convert config schema to JSON Schema.",
				schemaRole: "config",
			}),
		);
	});

	it("retains recursive object introspection and selects JSON CLI input", () => {
		const recursive = z.object({
			children: z.array(z.lazy(() => recursive)).optional(),
			name: z.string(),
		});
		const metadata = createOperationMetadata(
			operation({
				description: "Create a recursive tree",
				input: recursive,
				output: z.object({ ok: z.boolean() }),
				run: () => ({ ok: true }),
			}),
		);

		expect(metadata.input.properties).toMatchObject({
			children: { items: { $ref: "#" }, type: "array" },
		});
		expect(metadata.cli).toEqual({
			kind: "json",
			reason: 'Array field "children" does not have scalar items.',
		});
	});

	it("freezes JSON metadata through arbitrarily nested arrays", () => {
		const metadata = createSchemaMetadata(
			z.string().meta({ examples: [[[{ label: "deep" }]]] }),
			"config",
			"input",
		);
		const examples = metadata.examples;
		expect(Array.isArray(examples)).toBe(true);
		if (!Array.isArray(examples)) return;
		const first = examples[0];
		const second = Array.isArray(first) ? first[0] : undefined;
		const third = Array.isArray(second) ? second[0] : undefined;
		expect(Object.isFrozen(examples)).toBe(true);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
		expect(Object.isFrozen(third)).toBe(true);
	});
});

function readProperty(value: unknown, key: string): unknown {
	return isObject(value) ? Reflect.get(value, key) : undefined;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
