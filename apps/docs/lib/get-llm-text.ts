import type { source } from "@/lib/source";

export async function getLLMText(page: (typeof source)["$inferPage"]): Promise<string> {
	const content = await page.data.getText("processed");
	return `# ${page.data.title} (${page.url})\n\n${content}`;
}
