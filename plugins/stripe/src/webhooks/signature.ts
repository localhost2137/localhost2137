import { createHmac, timingSafeEqual } from "node:crypto";

export function signStripeWebhook(
	input: Readonly<{ body: string; secret: string; timestamp: string }>,
): string {
	const digest = createHmac("sha256", input.secret)
		.update(`${input.timestamp}.${input.body}`, "utf8")
		.digest("hex");
	return `t=${input.timestamp},v1=${digest}`;
}

export function verifyStripeWebhookSignature(
	input: Readonly<{ body: string; secret: string; signature: string }>,
): boolean {
	const parts = new Map(
		input.signature.split(",").map((part) => {
			const separator = part.indexOf("=");
			return separator < 1 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
		}),
	);
	const timestamp = parts.get("t");
	const actualDigest = parts.get("v1");
	if (!timestamp || !actualDigest) return false;
	const expected = signStripeWebhook({ body: input.body, secret: input.secret, timestamp }).slice(
		`t=${timestamp},v1=`.length,
	);
	const actual = Buffer.from(actualDigest);
	const expectedBuffer = Buffer.from(expected);
	return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
