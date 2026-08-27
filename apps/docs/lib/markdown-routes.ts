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

export function rewriteMarkdownPageLinks(markdown: string, pageUrls: ReadonlySet<string>): string {
	return markdown.replace(/\]\((\/[^)\s]*)\)/g, (link, target: string) => {
		const suffixStart = target.search(/[?#]/);
		const pageUrl = suffixStart === -1 ? target : target.slice(0, suffixStart);
		if (!pageUrls.has(pageUrl)) return link;

		const suffix = suffixStart === -1 ? "" : target.slice(suffixStart);
		return `](${markdownRouteForPage(pageUrl)}${suffix})`;
	});
}
