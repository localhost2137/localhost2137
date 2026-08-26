import { describe, expect, it } from "vitest";
import { pageResult, readPagination } from "../src/api/pagination.js";
import {
	optionalBoolean,
	optionalString,
	requiredString,
	type SlackRequestArguments,
} from "../src/api/slack-request.js";

describe("Slack API input validation", () => {
	it.each([
		[undefined, undefined],
		["", undefined],
		[true, true],
		[false, false],
		["true", true],
		["1", true],
		["false", false],
		["0", false],
	] as const)("reads Slack boolean value %j", (value, expected) => {
		expect(optionalBoolean(requestWith("value", value), "value")).toBe(expected);
	});

	it.each(["yes", 1])("rejects non-boolean Slack value %j", (value) => {
		expect(() => optionalBoolean(requestWith("value", value), "value")).toThrow(
			/Slack argument value must be a boolean/,
		);
	});

	it("distinguishes absent, optional, invalid, and required strings", () => {
		expect(optionalString(requestWith("value", undefined), "value")).toBeUndefined();
		expect(optionalString(requestWith("value", ""), "value")).toBeUndefined();
		expect(optionalString(requestWith("value", "general"), "value")).toBe("general");
		expect(() => optionalString(requestWith("value", true), "value")).toThrow(
			/Slack argument value must be a string/,
		);
		expect(() => requiredString(requestWith("value", ""), "value", "no_text")).toThrow(
			expect.objectContaining({ code: "no_text" }),
		);
	});

	it.each(["not-a-number", 0, 1.5, 1_000])("rejects invalid pagination limit %j", (limit) => {
		expect(() => readPagination(requestWith("limit", limit), resultSet)).toThrow(
			expect.objectContaining({ code: "invalid_limit" }),
		);
	});

	it.each([
		"not-json",
		cursor(null),
		cursor({}),
		cursor({ version: 2 }),
		cursor({ version: 1 }),
		cursor({ method: 7, version: 1 }),
		cursor({ method: "users.list", version: 1 }),
		cursor({ filter: 7, method: "users.list", version: 1 }),
		cursor({ filter: "", method: "users.list", version: 1 }),
		cursor({ filter: "", key: 7, method: "users.list", version: 1 }),
	])("rejects malformed opaque cursor %j", (value) => {
		expect(() => readPagination(requestWith("cursor", value), resultSet)).toThrow(
			expect.objectContaining({ code: "invalid_cursor" }),
		);
	});

	it("binds a valid cursor to its method and filter", () => {
		const firstPage = pageResult(["U000000", "U000001"], {
			...resultSet,
			key: (value) => value,
			limit: 1,
		});
		expect(firstPage).toMatchObject({ items: ["U000000"] });
		expect(firstPage.nextCursor).not.toBe("");
		expect(readPagination(requestWith("cursor", firstPage.nextCursor), resultSet)).toEqual({
			afterKey: "U000000",
			limit: 100,
		});
		expect(() =>
			readPagination(requestWith("cursor", firstPage.nextCursor), {
				filter: "admins-only",
				method: "users.list",
			}),
		).toThrow(expect.objectContaining({ code: "invalid_cursor" }));
	});

	it("omits a cursor when a page has no following item", () => {
		expect(pageResult([], { ...resultSet, key: (value: string) => value, limit: 1 })).toEqual({
			items: [],
			nextCursor: "",
		});
		expect(pageResult(["U000000"], { ...resultSet, key: (value) => value, limit: 1 })).toEqual({
			items: ["U000000"],
			nextCursor: "",
		});
	});
});

const resultSet = Object.freeze({ filter: "", method: "users.list" });

function requestWith(
	name: string,
	value: boolean | number | string | undefined,
): SlackRequestArguments {
	return Object.freeze({
		values: Object.freeze(value === undefined ? {} : { [name]: value }),
	});
}

function cursor(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
