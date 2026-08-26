import { GlassLayout } from "fumadocs-ui/layouts/glass";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function DocumentationLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<GlassLayout {...baseOptions()} tree={source.getPageTree()}>
			{children}
		</GlassLayout>
	);
}
