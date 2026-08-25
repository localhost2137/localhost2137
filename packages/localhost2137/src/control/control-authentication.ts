import { LocalhostError } from "../authoring/localhost-error.js";

export class ControlAuthenticator {
	readonly #token: string;

	constructor(token: string) {
		if (token.trim() === "" || /\s/.test(token)) {
			throw new TypeError("Control token must be a non-empty value without whitespace.");
		}
		this.#token = token;
	}

	authenticate(request: Request): void {
		if (request.headers.has("origin")) {
			throw new LocalhostError(
				"BROWSER_ORIGIN_REJECTED",
				"Browser-origin control requests are not allowed.",
				{ status: 403 },
			);
		}
		const authorization = request.headers.get("authorization");
		const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
		if (!match?.[1] || !constantTimeEqual(match[1], this.#token)) {
			throw new LocalhostError(
				"AUTHENTICATION_REQUIRED",
				"A valid control bearer token is required.",
				{ status: 401 },
			);
		}
	}
}

function constantTimeEqual(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}
