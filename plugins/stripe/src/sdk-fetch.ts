export type StripeSdkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Rewrites an SDK request's origin to an instance-scoped service URL while preserving its path.
 * This keeps the runtime router generic even for SDKs whose API origin cannot contain a path.
 */
export function createStripeSdkFetch(
	serviceUrl: string,
	fetchImplementation: StripeSdkFetch = globalThis.fetch,
): StripeSdkFetch {
	const base = normalizedServiceUrl(serviceUrl);
	return (input, init) => {
		const source = requestUrl(input);
		const target = new URL(`${base.pathname}${source.pathname}`.replace(/\/{2,}/g, "/"), base);
		target.search = source.search;
		if (input instanceof Request) {
			return fetchImplementation(new Request(target, input), init);
		}
		return fetchImplementation(target, init);
	};
}

function normalizedServiceUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("Stripe SDK service URL must use HTTP or HTTPS.");
	}
	if (url.search || url.hash) {
		throw new TypeError("Stripe SDK service URL cannot contain a query or fragment.");
	}
	url.pathname = url.pathname.replace(/\/$/, "");
	return url;
}

function requestUrl(input: RequestInfo | URL): URL {
	if (input instanceof URL) return input;
	if (input instanceof Request) return new URL(input.url);
	return new URL(input);
}
