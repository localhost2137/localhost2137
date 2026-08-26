import { getMDXComponents } from "@/components/mdx";
import { source } from "@/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/glass/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

interface PageProps {
	readonly params: Promise<{ readonly slug?: string[] }>;
}

export default async function DocumentationPage({ params }: PageProps) {
	const page = source.getPage((await params).slug);
	if (!page) notFound();
	const MDX = page.data.body;

	return (
		<DocsPage toc={page.data.toc}>
			<DocsTitle>{page.data.title}</DocsTitle>
			<DocsDescription>{page.data.description}</DocsDescription>
			<DocsBody>
				<MDX components={getMDXComponents()} />
			</DocsBody>
		</DocsPage>
	);
}

export function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
	const page = source.getPage((await params).slug);
	if (!page) notFound();
	return {
		description: page.data.description,
		title: page.data.title,
	};
}
