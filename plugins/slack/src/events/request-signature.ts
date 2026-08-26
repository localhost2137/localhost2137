import { createHmac, timingSafeEqual } from "node:crypto";

export function signSlackRequest(
	input: Readonly<{
		body: string;
		secret: string;
		timestamp: string;
	}>,
): string {
	return `v0=${createHmac("sha256", input.secret)
		.update(`v0:${input.timestamp}:${input.body}`, "utf8")
		.digest("hex")}`;
}

export function verifySlackRequestSignature(
	input: Readonly<{
		body: string;
		secret: string;
		signature: string;
		timestamp: string;
	}>,
): boolean {
	const expected = Buffer.from(signSlackRequest(input));
	const actual = Buffer.from(input.signature);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
