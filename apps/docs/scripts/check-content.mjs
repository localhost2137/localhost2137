import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownRouteForPage, rewriteLLMIndexLinks } from "../lib/markdown-routes.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsRoot, "content/docs");
const repositoryRoot = resolve(docsRoot, "../..");

const expectedPages = new Map([
	["index.mdx", "/"],
	["operations-and-apis.mdx", "/operations-and-apis"],
	["instances.mdx", "/instances"],
	["getting-started.mdx", "/getting-started"],
	["existing-application.mdx", "/existing-application"],
	["configuration.mdx", "/configuration"],
	["cli.mdx", "/cli"],
	["testing.mdx", "/testing"],
	["virtual-time.mdx", "/virtual-time"],
	["plugins/using.mdx", "/plugins/using"],
	["plugins/authoring.mdx", "/plugins/authoring"],
	["first-party/slack.mdx", "/first-party/slack"],
	["first-party/stripe.mdx", "/first-party/stripe"],
	["agents.mdx", "/agents"],
	["limitations.mdx", "/limitations"],
]);

const documentationFirstCommands = Object.freeze([
	"localhost init",
	"localhost demo clone <name> [directory]",
]);

const files = (await listFiles(contentRoot))
	.filter((file) => file.endsWith(".mdx"))
	.map((file) => relative(contentRoot, file))
	.sort(codeUnitOrder);
assert.deepEqual(
	files,
	[...expectedPages.keys()].sort(codeUnitOrder),
	"Docs page inventory drifted.",
);

const pageUrls = new Set(expectedPages.values());
const content = new Map();
for (const file of files) {
	const source = await readFile(join(contentRoot, file), "utf8");
	content.set(file, source);
	const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
	assert(frontmatter, `${file} must begin with frontmatter.`);
	assert(/^title:\s+\S.+$/m.test(frontmatter), `${file} must have a specific title.`);
	assert(/^description:\s+\S.+$/m.test(frontmatter), `${file} must have a useful description.`);
	assert(!/\b(lorem ipsum|revolutionary|game[- ]changing|best[- ]in[- ]class)\b/i.test(source));

	for (const match of source.matchAll(/\]\((\/[^\s)#?]+)(?:#[^)]+)?\)/g)) {
		const target = match[1];
		assert(
			pageUrls.has(target) || target === "/llms.txt" || target === "/llms-full.txt",
			`${file} links to unknown internal page ${target}.`,
		);
	}
}

const combined = [...content.values()].join("\n");
for (const command of documentationFirstCommands) {
	assert(combined.includes(command), `The docs must include ${command}.`);
}
for (const command of [
	"localhost snapshot",
	"localhost instance start",
	"localhost instance stop",
]) {
	assert(!combined.includes(command), `Deferred command leaked into the docs: ${command}.`);
}

const commandProgram = await readFile(
	join(repositoryRoot, "packages/localhost2137/src/cli/command-program.ts"),
	"utf8",
);
assert(!commandProgram.includes('program.command("init")'));
assert(!commandProgram.includes('program.command("demo")'));
assert.equal(
	documentationFirstCommands.length,
	2,
	"Only the reviewed init and demo-clone contracts may lead implementation.",
);

const agents = content.get("agents.mdx");
assert(agents?.includes("title: For LLMs"));
assert(agents?.includes("## Copy-paste prompts"));
assert(agents?.includes("skills/use-localhost2137"));
assert(agents?.includes("skills/build-localhost2137-plugin"));
assert(agents?.includes("There is no automatic skill installer"));

const introduction = content.get("index.mdx");
assert(introduction?.includes("title: What localhost2137 is"));

const navigation = JSON.parse(await readFile(join(contentRoot, "meta.json"), "utf8"));
assert.equal(navigation.pages[0], "agents", "For LLMs must remain the first sidebar page.");
const layoutOptions = await readFile(join(docsRoot, "lib/layout.shared.tsx"), "utf8");
assert(!layoutOptions.includes('text: "llms.txt"'));
assert(!layoutOptions.includes('url: "/llms.txt"'));

const layout = await readFile(join(docsRoot, "app/routes/docs.tsx"), "utf8");
assert(layout.includes('from "fumadocs-ui/layouts/glass"'));
assert(layout.includes('from "fumadocs-ui/layouts/glass/page"'));
const stylesheet = await readFile(join(docsRoot, "app/global.css"), "utf8");
assert(stylesheet.includes('@import "fumadocs-ui/css/generated/glass.css"'));
assert(stylesheet.includes("#nd-sidebar [data-radix-scroll-area-viewport] a"));
assert(stylesheet.includes("display: flex"));

const routeModule = await import("../app/routes.ts");
const routeConfig = routeModule.default;
assert(
	routeConfig.some((entry) => entry.file === "routes/docs.tsx" && entry.index === true),
	"The root docs page must use a native index route.",
);
assert(
	routeConfig.some((entry) => entry.file === "routes/docs.tsx" && entry.path === "*"),
	"Nested docs pages must use the docs splat route.",
);
for (const [path, file] of [
	["api/search", "routes/search.ts"],
	["llms.txt", "routes/llms-index.ts"],
	["llms-full.txt", "routes/llms-full.ts"],
]) {
	assert(
		routeConfig.some((entry) => entry.file === file && entry.path === path),
		`Missing React Router resource route: ${path}`,
	);
}

const expectedContentMarkdownPaths = files.map((file) =>
	file === "index.mdx" ? "index.md" : `${file.slice(0, -".mdx".length)}.md`,
);
assert.deepEqual(
	routeModule.markdownRoutePaths,
	expectedContentMarkdownPaths,
	"Markdown routes must be derived recursively from the content tree.",
);
assert.deepEqual(
	routeConfig.filter((entry) => entry.file === "routes/markdown.ts").map((entry) => entry.path),
	expectedContentMarkdownPaths,
	"Every content page must have one exact Markdown resource route.",
);
assert(
	routeModule.markdownRoutePaths.every((path) => !path.includes(":")),
	"Markdown routes must not use depth-specific dynamic segments.",
);

const viteConfig = await readFile(join(docsRoot, "vite.config.ts"), "utf8");
for (const plugin of ["cloudflare(", "fumadocsMdx(", "tailwindcss(", "reactRouter("]) {
	assert(viteConfig.includes(plugin), `Vite config must include ${plugin}`);
}
assert(
	viteConfig.indexOf("cloudflare(") < viteConfig.indexOf("reactRouter("),
	"The Cloudflare plugin must run before the React Router plugin.",
);

const reactRouterConfig = await readFile(join(docsRoot, "react-router.config.ts"), "utf8");
assert(reactRouterConfig.includes("ssr: true"), "Docs must keep server rendering enabled.");
const worker = await readFile(join(docsRoot, "workers/app.ts"), "utf8");
assert(worker.includes('import("virtual:react-router/server-build")'));
assert(worker.includes("createRequestHandler"));
assert(worker.includes("isMarkdownPath(pathname)"));
assert(worker.includes("markdownNotFoundResponse()"));

const wrangler = JSON.parse(await readFile(join(docsRoot, "wrangler.jsonc"), "utf8"));
assert.equal(wrangler.name, "localhost2137-docs");
assert.equal(wrangler.main, "./workers/app.ts");
assert.equal(wrangler.compatibility_date, "2026-08-26");
assert(!("compatibility_flags" in wrangler));
assert(!("assets" in wrangler), "The Vite plugin owns generated asset-directory wiring.");
assert.equal(wrangler.observability?.enabled, true);
assert.deepEqual(wrangler.routes, [
	{
		pattern: "localhost2137.dev",
		custom_domain: true,
	},
]);
assert(!("account_id" in wrangler), "Wrangler config must not contain account-specific state.");

const packageManifest = JSON.parse(await readFile(join(docsRoot, "package.json"), "utf8"));
assert(!packageManifest.dependencies?.next && !packageManifest.devDependencies?.next);
assert.equal(packageManifest.scripts.build, "react-router build");
assert.equal(packageManifest.scripts.dev, "react-router dev");
assert.equal(packageManifest.scripts.deploy, "pnpm build && wrangler deploy");

const workspaceConfig = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
assert(/^autoInstallPeers: false$/m.test(workspaceConfig));
assert(/^minimumReleaseAge: 1440$/m.test(workspaceConfig));
const lockfile = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
assert(/^ {2}autoInstallPeers: false$/m.test(lockfile));
assert(!/^ {2}next@/m.test(lockfile), "The lockfile must not resolve Next.js.");
assert(!/@next\/swc/.test(lockfile), "The lockfile must not resolve Next.js SWC packages.");
const installedPackages = await readdir(join(repositoryRoot, "node_modules/.pnpm"));
assert(!installedPackages.some((name) => /^next@|^@next\+/.test(name)));
await assertMissing(join(docsRoot, "node_modules/next"));

for (const retiredPath of [
	"next-env.d.ts",
	"next.config.mjs",
	"postcss.config.mjs",
	"source.config.ts",
	"app/(docs)/layout.tsx",
	"app/api/search/route.ts",
	"app/llms.txt/route.ts",
]) {
	await assertMissing(join(docsRoot, retiredPath));
}

const sourceIndexFixture = [...expectedPages]
	.map(([file, pageUrl]) => `- [${file}](${pageUrl})`)
	.join("\n");
const markdownIndex = rewriteLLMIndexLinks(sourceIndexFixture, pageUrls);
const markdownTargets = [...markdownIndex.matchAll(/\]\((\/[^)\s]*)\)/g)]
	.map((match) => match[1])
	.sort(codeUnitOrder);
const expectedMarkdownTargets = [...pageUrls].map(markdownRouteForPage).sort(codeUnitOrder);
assert.deepEqual(
	markdownTargets,
	expectedMarkdownTargets,
	"Every llms.txt link must target the Markdown route for one docs page.",
);

const llmsIndexRoute = await readFile(join(docsRoot, "app/routes/llms-index.ts"), "utf8");
assert(llmsIndexRoute.includes("rewriteLLMIndexLinks"));
for (const route of [
	"app/routes/search.ts",
	"app/routes/llms-index.ts",
	"app/routes/llms-full.ts",
	"app/routes/markdown.ts",
	"lib/markdown-resource.ts",
]) {
	assert((await readFile(join(docsRoot, route), "utf8")).length > 0, `Missing ${route}.`);
}

process.stdout.write(
	`Validated ${files.length} docs pages, navigation links, docs-first commands, Glass wiring, skills references, and Markdown route mapping.\n`,
);

async function listFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? listFiles(path) : [path];
		}),
	);
	return nested.flat();
}

function codeUnitOrder(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function assertMissing(path) {
	try {
		await access(path);
		assert.fail(`Retired Next.js file still exists: ${relative(docsRoot, path)}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}
