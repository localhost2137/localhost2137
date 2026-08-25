import { LocalhostError } from "../authoring/localhost-error.js";

export const CONTROL_BODY_LIMIT_BYTES: number = 64 * 1024;

export function assertJsonMutation(request: Request): void {
	if (!isMutation(request.method)) return;
	const contentType = request.headers.get("content-type") ?? "";
	if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
		throw new LocalhostError(
			"UNSUPPORTED_MEDIA_TYPE",
			"Control mutations require Content-Type: application/json.",
			{ status: 415 },
		);
	}
}

export async function readControlJson(
	request: Request,
	limitBytes: number = CONTROL_BODY_LIMIT_BYTES,
): Promise<unknown> {
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
		throw new TypeError("Control body limit must be a positive safe integer.");
	}
	const declaredLength = request.headers.get("content-length");
	if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limitBytes) {
		throw requestTooLarge(limitBytes);
	}
	if (!request.body) throw invalidJson();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > limitBytes) {
			await reader.cancel("control request body limit exceeded").catch(() => undefined);
			throw requestTooLarge(limitBytes);
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		throw invalidJson();
	}
}

function isMutation(method: string): boolean {
	return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function invalidJson(): LocalhostError {
	return new LocalhostError("INVALID_REQUEST", "Control request body must be valid JSON.", {
		status: 400,
	});
}

function requestTooLarge(limitBytes: number): LocalhostError {
	return new LocalhostError(
		"REQUEST_TOO_LARGE",
		`Control request body exceeds the ${limitBytes}-byte limit.`,
		{ status: 413 },
	);
}
