import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import("next").NextConfig} */
const config = {
	reactStrictMode: true,
	async rewrites() {
		return [
			{
				destination: "/llms.mdx/:path*",
				source: "/:path*.md",
			},
		];
	},
};

export default withMDX(config);
