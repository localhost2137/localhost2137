import { useFumadocsLoader } from "fumadocs-core/source/client";
import { GlassLayout } from "fumadocs-ui/layouts/glass";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/glass/page";
import { use } from "react";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { docs, source } from "@/lib/source";
import type { Route } from "./+types/docs";

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
	if (!loaderData) return [];

	return [
		{ title: `${loaderData.title} — localhost2137` },
		{ name: "description", content: loaderData.description },
	];
}

export async function loader({ params }: Route.LoaderArgs) {
	const slugs = (params["*"] ?? "").split("/").filter(Boolean);
	const page = source.getPage(slugs);
	if (!page) throw new Response("Not found", { status: 404 });

	const content = docs.getPage(page.path);
	if (!content) throw new Error(`Missing compiled content for ${page.path}`);
	await content.preload();

	return {
		description: page.data.description,
		path: page.path,
		pageTree: await source.serializePageTree(source.getPageTree()),
		title: page.data.title,
	};
}

function Content({ path }: Readonly<{ path: string }>) {
	const page = docs.getPage(path);
	if (!page) throw new Error(`Unknown documentation page: ${path}`);

	const { toc } = use(page.load());
	const MDX = page.body;

	return (
		<DocsPage toc={toc}>
			<DocsTitle>{page.title}</DocsTitle>
			<DocsDescription>{page.description}</DocsDescription>
			<DocsBody>
				<MDX components={useMDXComponents()} />
			</DocsBody>
		</DocsPage>
	);
}

export default function DocumentationPage({ loaderData }: Route.ComponentProps) {
	const { path, pageTree } = useFumadocsLoader(loaderData);

	return (
		<GlassLayout {...baseOptions()} tree={pageTree}>
			<Content path={path} />
		</GlassLayout>
	);
}
