import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsRoot, "content/docs");
const pages = await readPages(contentRoot);
assert.equal(pages.size, 23, "Built route validation must cover all 23 documentation pages.");

const sidebarUrls = await readSidebarUrls(contentRoot, pages);
assert.deepEqual(
	new Set(sidebarUrls),
	new Set([...pages.values()].map((page) => page.url)),
	"The sidebar must include every docs page.",
);
assert.equal(
	new Set(sidebarUrls).size,
	sidebarUrls.length,
	"The sidebar must include every docs page exactly once.",
);

const workerModule = await import(new URL("../build/server/index.js", import.meta.url).href);
const worker = workerModule.default;
assert.equal(typeof worker?.fetch, "function", "The built docs worker must export fetch().");

const pageUrls = new Set(sidebarUrls);
const markdownUrls = new Set(sidebarUrls.map(markdownRouteForPage));
const markdownBodies = new Map();

for (const url of sidebarUrls) {
	const html = await request(url);
	assert.equal(html.status, 200, `${url} must return HTML.`);
	assert.match(html.headers.get("content-type") ?? "", /^text\/html\b/);

	const markdownUrl = markdownRouteForPage(url);
	const markdown = await request(markdownUrl);
	assert.equal(markdown.status, 200, `${markdownUrl} must return Markdown.`);
	assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
	const body = await markdown.text();
	markdownBodies.set(url, body);

	const page = [...pages.values()].find((candidate) => candidate.url === url);
	assert(page, `Missing source page for ${url}.`);
	assertRewrittenSourceLinks(page.source, body, pageUrls);
	assertNoHumanDocsLinks(body, pageUrls);
}

const llmsIndex = await request("/llms.txt");
assert.equal(llmsIndex.status, 200);
assert.equal(llmsIndex.headers.get("content-type"), "text/plain; charset=utf-8");
const llmsIndexBody = await llmsIndex.text();
const indexedMarkdownUrls = [...llmsIndexBody.matchAll(/\]\((\/[^)\s]+)\)/g)]
	.map((match) => splitTarget(match[1]).pageUrl)
	.filter((url) => markdownUrls.has(url));
assert.deepEqual(
	indexedMarkdownUrls,
	sidebarUrls.map(markdownRouteForPage),
	"llms.txt must list every Markdown page in sidebar order.",
);

const llmsFull = await request("/llms-full.txt");
assert.equal(llmsFull.status, 200);
assert.equal(llmsFull.headers.get("content-type"), "text/plain; charset=utf-8");
const llmsFullBody = await llmsFull.text();
assert.equal(
	llmsFullBody,
	sidebarUrls.map((url) => markdownBodies.get(url)).join("\n\n"),
	"llms-full.txt must concatenate the canonical Markdown pages in sidebar order.",
);
assertNoHumanDocsLinks(llmsFullBody, pageUrls);

const agentsMarkdown = markdownBodies.get("/agents") ?? "";
assert(agentsMarkdown.includes("](/llms.txt)"), "Non-page internal links must remain unchanged.");
assert(
	(markdownBodies.get("/") ?? "").includes(
		"](/callbacks.md#parallel-receivers-require-a-routing-rule)",
	),
	"Markdown pages must preserve fragments while rewriting docs links.",
);

process.stdout.write(
	`Validated ${sidebarUrls.length} HTML routes, ${sidebarUrls.length} Markdown routes, and ordered llms outputs.\n`,
);

async function request(pathname) {
	return worker.fetch(new Request(`https://localhost2137.dev${pathname}`), {}, {});
}

async function readPages(root) {
	const files = (await listFiles(root)).filter((file) => file.endsWith(".mdx"));
	return new Map(
		await Promise.all(
			files.map(async (file) => {
				const sourcePath = relative(root, file).replaceAll("\\", "/");
				const stem = sourcePath.slice(0, -".mdx".length);
				const url = stem === "index" ? "/" : `/${stem}`;
				return [sourcePath, { source: await readFile(file, "utf8"), url }];
			}),
		),
	);
}

async function readSidebarUrls(directory, pageByPath, prefix = "") {
	const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
	const output = [];
	for (const item of meta.pages) {
		if (/^---(?:\[[^\]]+])?.*---$/.test(item)) continue;
		const pagePath = prefix ? `${prefix}/${item}.mdx` : `${item}.mdx`;
		const page = pageByPath.get(pagePath);
		if (page) {
			output.push(page.url);
			continue;
		}

		const folderPrefix = prefix ? `${prefix}/${item}` : item;
		if ([...pageByPath.keys()].some((path) => path.startsWith(`${folderPrefix}/`))) {
			output.push(...(await readSidebarUrls(join(directory, item), pageByPath, folderPrefix)));
			continue;
		}

		assert.fail(
			`Unknown sidebar entry ${JSON.stringify(item)} in ${relative(contentRoot, directory)}.`,
		);
	}
	return output;
}

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

function assertRewrittenSourceLinks(source, markdown, knownPageUrls) {
	for (const match of withoutFencedCode(source).matchAll(/\]\((\/[^)\s]*)\)/g)) {
		const target = splitTarget(match[1]);
		if (!knownPageUrls.has(target.pageUrl)) continue;
		assert(
			markdown.includes(`](${markdownRouteForPage(target.pageUrl)}${target.suffix})`),
			`Generated Markdown did not rewrite ${match[1]} with its suffix intact.`,
		);
	}
}

function assertNoHumanDocsLinks(markdown, knownPageUrls) {
	for (const match of markdown.matchAll(/\]\((\/[^)\s]*)\)/g)) {
		const { pageUrl } = splitTarget(match[1]);
		assert(!knownPageUrls.has(pageUrl), `Generated Markdown retained human docs link ${match[1]}.`);
	}
}

function splitTarget(target) {
	const suffixStart = target.search(/[?#]/);
	return {
		pageUrl: suffixStart === -1 ? target : target.slice(0, suffixStart),
		suffix: suffixStart === -1 ? "" : target.slice(suffixStart),
	};
}

function markdownRouteForPage(pageUrl) {
	return pageUrl === "/" ? "/index.md" : `${pageUrl}.md`;
}

function withoutFencedCode(source) {
	return source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}
