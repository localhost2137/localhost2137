import { describe, expect, it } from "vitest";
import {
	ownLoopbackRuntimeUrl,
	ownRuntimeDescriptor,
	RuntimeDescriptorValidationError,
} from "../../src/control/runtime-descriptor.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

describe("runtime descriptor boundary", () => {
	it("strictly owns a canonical descriptor", () => {
		const source = descriptor();
		const owned = ownRuntimeDescriptor(source);
		source.ownerId = "replacement_owner_123456789";

		expect(owned).toEqual(descriptor());
		expect(Object.isFrozen(owned)).toBe(true);
		expect(owned).not.toBe(source);
	});

	it.each([
		["a noncanonical fingerprint", { configFingerprint: "sha256:abc" }],
		["a zero pid", { pid: 0 }],
		["a negative pid", { pid: -1 }],
		["an unsafe pid", { pid: Number.MAX_SAFE_INTEGER + 1 }],
		["a noncanonical timestamp", { startedAt: "2026-08-26T12:00:00Z" }],
		["a remote URL", { url: "http://example.test:2137" }],
		["a URL with credentials", { url: "http://token@127.0.0.1:2137" }],
		["a URL with a path", { url: "http://127.0.0.1:2137/runtime" }],
	])("rejects %s", (_label, replacement) => {
		expect(() => ownRuntimeDescriptor({ ...descriptor(), ...replacement })).toThrow(
			RuntimeDescriptorValidationError,
		);
	});

	it("distinguishes unsupported schema and protocol versions", () => {
		for (const [replacement, code] of [
			[{ schemaVersion: 2 }, "UNSUPPORTED_SCHEMA_VERSION"],
			[{ protocolVersion: "v2" }, "UNSUPPORTED_PROTOCOL_VERSION"],
		] as const) {
			try {
				ownRuntimeDescriptor({ ...descriptor(), ...replacement });
				throw new Error("Expected descriptor validation to fail.");
			} catch (cause) {
				expect(cause).toMatchObject({ code });
			}
		}
	});

	it("rejects unknown fields and accessors without invoking them", () => {
		const value = descriptor() as Record<string, unknown>;
		value.unknown = true;
		expect(() => ownRuntimeDescriptor(value)).toThrow(/unknown field/);

		let accessed = false;
		const accessor = descriptor() as Record<string, unknown>;
		Object.defineProperty(accessor, "ownerId", {
			enumerable: true,
			get: () => {
				accessed = true;
				return "unsafe_owner_123456789";
			},
		});
		expect(() => ownRuntimeDescriptor(accessor)).toThrow(/data property/);
		expect(accessed).toBe(false);
	});

	it.each([
		"http://localhost:2137",
		"http://127.0.0.1:2137/",
		"http://127.12.34.56:2137",
		"http://[::1]:2137",
	])("normalizes the loopback origin %s", (url) => {
		expect(ownLoopbackRuntimeUrl(url)).toBe(new URL(url).origin);
	});
});

function descriptor() {
	return {
		configFingerprint: FINGERPRINT,
		ownerId: "runtime_owner_123456789",
		pid: 21_337,
		protocolVersion: "v1" as const,
		schemaVersion: 1 as const,
		startedAt: "2026-08-26T12:00:00.000Z",
		url: "http://127.0.0.1:2137",
	};
}
