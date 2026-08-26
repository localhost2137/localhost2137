export function markdownRouteForPage(pageUrl: string): string {
	return pageUrl === "/" ? "/index.md" : `${pageUrl}.md`;
}

export function rewriteLLMIndexLinks(index: string, pageUrls: ReadonlySet<string>): string {
	return index.replace(/\]\((\/[^)\s]*)\)/g, (_link, pageUrl: string) => {
		if (!pageUrls.has(pageUrl)) {
			throw new TypeError(`LLM index contains an unknown page URL: ${pageUrl}`);
		}
		return `](${markdownRouteForPage(pageUrl)})`;
	});
}
