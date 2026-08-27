import { rewriteMarkdownPageLinks } from "@/lib/markdown-routes";
import { source } from "@/lib/source";

const pageUrls = new Set(source.getPages().map((page) => page.url));

export async function getLLMText(page: (typeof source)["$inferPage"]): Promise<string> {
	const content = rewriteMarkdownPageLinks(await page.data.getText("processed"), pageUrls);
	return `# ${page.data.title} (${page.url})\n\n${content}`;
}
