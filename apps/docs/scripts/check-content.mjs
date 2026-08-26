import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownRouteForPage, rewriteLLMIndexLinks } from "../lib/markdown-routes.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsRoot, "content/docs");
const repositoryRoot = resolve(docsRoot, "../..");

const expectedPages = new Map([
	["index.mdx", "/"],
	["getting-started.mdx", "/getting-started"],
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
assert(agents?.includes("skills/use-localhost2137"));
assert(agents?.includes("skills/build-localhost2137-plugin"));
assert(agents?.includes("There is no automatic skill installer"));

const layout = await readFile(join(docsRoot, "app/(docs)/layout.tsx"), "utf8");
assert(layout.includes('from "fumadocs-ui/layouts/glass"'));
const stylesheet = await readFile(join(docsRoot, "app/global.css"), "utf8");
assert(stylesheet.includes('@import "fumadocs-ui/css/generated/glass.css"'));

const nextConfig = await readFile(join(docsRoot, "next.config.mjs"), "utf8");
assert(nextConfig.includes('source: "/:path*.md"'));
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

const llmsIndexRoute = await readFile(join(docsRoot, "app/llms.txt/route.ts"), "utf8");
assert(llmsIndexRoute.includes("rewriteLLMIndexLinks"));
for (const route of [
	"app/llms.txt/route.ts",
	"app/llms-full.txt/route.ts",
	"app/llms.mdx/[[...slug]]/route.ts",
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
