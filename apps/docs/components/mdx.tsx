import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function useMDXComponents(components?: MDXComponents): MDXComponents {
	return {
		...defaultMdxComponents,
		...components,
	} satisfies MDXComponents;
}

declare global {
	type MDXProvidedComponents = ReturnType<typeof useMDXComponents>;
}
