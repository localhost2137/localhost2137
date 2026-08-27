import { flattenTree } from "fumadocs-core/page-tree";
import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		async: true,
		postprocess: {
			includeProcessedMarkdown: true,
		},
	},
});

export const source = loader({
	baseUrl: "/",
	source: docs.toFumadocsSource(),
});

export function getSidebarPages(): Array<(typeof source)["$inferPage"]> {
	const pages = flattenTree(source.getPageTree().children).flatMap((node) => {
		const page = source.getNodePage(node);
		return page ? [page] : [];
	});
	const allPages = source.getPages();
	const orderedUrls = new Set(pages.map((page) => page.url));

	if (
		orderedUrls.size !== pages.length ||
		pages.length !== allPages.length ||
		allPages.some((page) => !orderedUrls.has(page.url))
	) {
		throw new Error("The sidebar must contain every documentation page exactly once.");
	}

	return pages;
}
