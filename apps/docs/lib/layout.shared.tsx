import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: (
				<span className="lh-wordmark">
					<span>localhost</span>
					<strong>2137</strong>
				</span>
			),
			url: "/",
		},
	};
}
