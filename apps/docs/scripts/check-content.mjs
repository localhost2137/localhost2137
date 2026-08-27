import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { markdownRouteForPage, rewriteLLMIndexLinks } from "../lib/markdown-routes.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsRoot, "content/docs");
const repositoryRoot = resolve(docsRoot, "../..");

const expectedPages = new Map([
	["index.mdx", "/"],
	["test-boundaries.mdx", "/test-boundaries"],
	["compatibility.mdx", "/compatibility"],
	["operations-and-apis.mdx", "/operations-and-apis"],
	["callbacks.mdx", "/callbacks"],
	["instances.mdx", "/instances"],
	["determinism.mdx", "/determinism"],
	["getting-started.mdx", "/getting-started"],
	["existing-application.mdx", "/existing-application"],
	["configuration.mdx", "/configuration"],
	["seeding.mdx", "/seeding"],
	["cli.mdx", "/cli"],
	["diagnosing.mdx", "/diagnosing"],
	["testing.mdx", "/testing"],
	["virtual-time.mdx", "/virtual-time"],
	["plugins/using.mdx", "/plugins/using"],
	["plugins/first-plugin.mdx", "/plugins/first-plugin"],
	["plugins/authoring.mdx", "/plugins/authoring"],
	["first-party/slack.mdx", "/first-party/slack"],
	["first-party/stripe.mdx", "/first-party/stripe"],
	["agents.mdx", "/agents"],
	["limitations.mdx", "/limitations"],
	["security.mdx", "/security"],
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
const markdownUrls = new Set([...pageUrls].map(markdownRouteForPage));
const content = new Map();
for (const file of files) {
	const source = await readFile(join(contentRoot, file), "utf8");
	content.set(file, source);
	const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
	assert(frontmatter, `${file} must begin with frontmatter.`);
	assert(/^title:\s+\S.+$/m.test(frontmatter), `${file} must have a specific title.`);
	assert(/^description:\s+\S.+$/m.test(frontmatter), `${file} must have a useful description.`);
	assert(!/\b(lorem ipsum|revolutionary|game[- ]changing|best[- ]in[- ]class)\b/i.test(source));
}

const headingIdsByPage = new Map(
	[...expectedPages].map(([file, pageUrl]) => [
		pageUrl,
		collectHeadingIds(content.get(file) ?? ""),
	]),
);
for (const [file, source] of content) {
	const prose = withoutFencedCode(source);
	for (const match of prose.matchAll(/\]\((\/[^\s)#?]*)(?:#([^\s)]+))?\)/g)) {
		const target = match[1];
		assert(
			pageUrls.has(target) ||
				markdownUrls.has(target) ||
				target === "/llms.txt" ||
				target === "/llms-full.txt",
			`${file} links to unknown internal page ${target}.`,
		);
		if (match[2]) assertInternalFragment(file, target, match[2], headingIdsByPage);
	}
	const ownPageUrl = expectedPages.get(file);
	assert(ownPageUrl, `${file} has no expected page URL.`);
	for (const match of prose.matchAll(/\]\(#([^\s)]+)\)/g)) {
		assertInternalFragment(file, ownPageUrl, match[1], headingIdsByPage);
	}
}

const combined = [...content.values()].join("\n");
for (const term of ["snapshot", "fork", "MCP"]) {
	assert(
		!new RegExp(`\\b${term}s?\\b`, "i").test(combined),
		`Reserved product vocabulary leaked into the docs: ${term}.`,
	);
}
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
const runtimeBoundaries = content.get("limitations.mdx");
assert(runtimeBoundaries?.includes("title: Runtime boundaries"));
assert(runtimeBoundaries?.includes("This page describes current behavior"));
assert(!/\b(deferred|roadmap|snapshots?|forks?|MCP)\b/i.test(runtimeBoundaries ?? ""));
const security = content.get("security.mdx");
assert(security?.includes("title: Local security model"));
assert(security?.includes("The runtime bearer token does not protect provider-shaped routes"));
assert(/There is no process, filesystem, or\s+network sandbox/.test(security ?? ""));
assert(security?.includes('{ "data": { "status": "ok", "version": "v1" } }'));
assert(security?.includes("Ordinary string values and the log"));
assert(security?.includes("message pass through unchanged"));
assert(runtimeBoundaries?.includes("A service-key change is not itself a migration"));

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

const diagnosing = content.get("diagnosing.mdx");
assert(diagnosing?.includes("serialized diagnostic identifies the selected config path"));
assert(!/\bLOCK(?:ED|_STALE|_CORRUPT)\b/.test(diagnosing ?? ""));
assert(diagnosing?.includes("Correlation IDs are scoped to one boundary"));
assert(diagnosing?.includes("`request`, `operation`, `delivery`, and `plugin` entries"));
assert(!diagnosing?.includes("`task`, `lifecycle`"));
const cli = content.get("cli.mdx");
assert(cli?.includes("request, operation, delivery, and plugin logs"));
assert(!cli?.includes("request, operation, lifecycle"));
assert(cli?.includes("Terminal one:"));
assert(cli?.includes("Terminal two:"));
assert(cli?.includes("Help-only invocations do not load config"));
assert(!cli?.includes("Every command first selects a config"));
assert(cli?.includes('`status: "issues"` still exits successfully'));
assert(cli?.includes("guidance omits the original correlation ID"));
assert(cli?.includes("does not expose structured error details"));
assert(cli?.includes("localhost_control_token="));
assert(!cli?.includes("export LOCALHOST_CONTROL_TOKEN"));
const configuration = content.get("configuration.mdx");
assert(configuration?.includes("The `port: 0` used by `createTestRuntime"));
assert(configuration?.includes("Renaming a key is therefore not a migration"));
assert(configuration?.includes("The runtime's `received` diagnostic records the value's type"));
assert(configuration?.includes("`.env` below `storage.dir`"));
assert(configuration?.includes("Removing or renaming a service while it still owes"));
assert(!configuration?.includes("in-process tests require port `0`"));
const testing = content.get("testing.mdx");
assert(testing?.includes("Reuse the runtime, not the world"));
assert(testing?.includes("It does not discover or attach to `localhost dev`"));
assert(testing?.includes("private bearer token for crossing a process boundary"));
assert(testing?.includes("`TestRuntimeCleanupError`"));
assert(testing?.includes("Clock advancement is a stronger transition"));
assert(testing?.includes("A create `ControlApiError` is an authoritative server rejection"));
assert(testing?.includes("running the scenario or destroying that ID"));
assert(testing?.includes("A transport or protocol failure leaves the outcome uncertain"));
assert(testing?.includes("cleanup ignores only a `ControlApiError` with"));
assert(!testing?.includes("it always attempts reconciliation after"));
assert(testing?.includes("The remote client is intentionally untyped"));
assert(!testing?.includes("one instance per test worker process, all on different ports"));
const virtualTime = content.get("virtual-time.mdx");
assert(virtualTime?.includes("Task tracking is a separate concern"));
assert(virtualTime?.includes("`01s`"));
assert(virtualTime?.includes("safe integer of milliseconds"));
assert(virtualTime?.includes("In real mode, they add 60 days"));
assert(virtualTime?.includes("does not expose the underlying cause"));
assert(!virtualTime?.includes("Fix the reported plugin"));
const callbacks = content.get("callbacks.mdx");
assert(callbacks?.includes("timeout and retry behavior"));
assert(callbacks?.includes("Those details are part of the plugin's compatibility surface"));
assert(callbacks?.includes("Separate instance storage never proves callback routing"));
assert(callbacks?.includes("When an installed plugin does"));
const pluginAuthoring = content.get("plugins/authoring.mdx");
assert(
	pluginAuthoring?.includes("Importing the plugin, or a config that mounts it, must be inert"),
);
assert(pluginAuthoring?.includes("a small, working public authoring shape"));
assert(!pluginAuthoring?.includes("complete public authoring surface"));
assert(pluginAuthoring?.includes("A failed `start` does not earn a later `stop`"));
assert(pluginAuthoring?.includes("`update` may receive any older stored version"));
assert(pluginAuthoring?.includes("The `State` returned by `start` is live process state"));
assert(pluginAuthoring?.includes("It is tracked automatically"));
assert(
	pluginAuthoring?.includes("Delivery attempt timeouts and retry policy belong to the plugin"),
);
assert(
	pluginAuthoring?.includes(
		"runtime and control operations can impose separate wall-clock safety limits",
	),
);
assert(!pluginAuthoring?.includes("the runtime still owns those"));
assert(
	pluginAuthoring?.includes(
		"The generic contract proves runtime integration, not provider fidelity",
	),
);
assert(pluginAuthoring?.includes("A state-version-1 plugin has no honest predecessor"));
const pluginUsing = content.get("plugins/using.mdx");
assert(pluginUsing?.includes("There is no plugin registry or automatic package discovery"));
assert(pluginUsing?.includes("Temporary test storage limits what world state survives the test"));
assert(pluginUsing?.includes("`describe` does not enumerate provider routes or connection values"));
assert(pluginUsing?.includes("Unscoped `localhost describe --json` returns one summary"));
assert(pluginUsing?.includes("scoped CLI output intentionally strips `pluginId`"));
assert(pluginUsing?.includes("not a compatibility manifest or health check"));
assert(pluginUsing?.includes("A `seed_failed` instance remains addressable"));
assert(pluginUsing?.includes("`stateVersion` describes durable storage only"));
assert(pluginUsing?.includes("Do not use reset as a rollback"));
const firstPartySlack = content.get("first-party/slack.mdx");
assert(
	firstPartySlack?.includes("Public Web API channel arguments deliberately require stored IDs"),
);
assert(firstPartySlack?.includes("ascending stored-ID order"));
assert(!firstPartySlack?.includes("users in creation order"));
assert(firstPartySlack?.includes("first character must be an ASCII lowercase letter or digit"));
assert(firstPartySlack?.includes("There are at most four attempts"));
assert(firstPartySlack?.includes("The tested client is `@slack/bolt` 5.0.0"));
assert(firstPartySlack?.includes("Messages and pending deliveries cannot be seeded"));
const firstPartyStripe = content.get("first-party/stripe.mdx");
assert(firstPartyStripe?.includes("Products and prices are intentionally read-only through HTTP"));
assert(firstPartyStripe?.includes("Stripe Node 22.5.0"));
assert(firstPartyStripe?.includes("this plugin does not schedule a retry"));
assert(firstPartyStripe?.includes("The helper verifies the HMAC digest only"));
for (const [file, source] of content) {
	for (const fence of source.matchAll(/```sh\n([\s\S]*?)```/g)) {
		assert(
			!/<[^>\n]+>/.test(fence[1]),
			`${file} contains an angle-bracket shell placeholder in an sh fence.`,
		);
	}
}

const navigation = JSON.parse(await readFile(join(contentRoot, "meta.json"), "utf8"));
assert.equal(navigation.pages[0], "agents", "For LLMs must remain the first sidebar page.");
assert.deepEqual(navigation.pages, [
	"agents",
	"---Start---",
	"index",
	"getting-started",
	"---Guides---",
	"existing-application",
	"testing",
	"seeding",
	"diagnosing",
	"---Concepts---",
	"test-boundaries",
	"operations-and-apis",
	"instances",
	"callbacks",
	"determinism",
	"compatibility",
	"---Reference---",
	"configuration",
	"cli",
	"virtual-time",
	"limitations",
	"security",
	"---Plugins---",
	"plugins",
	"first-party",
]);
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
	`Validated ${files.length} docs pages, navigation and fragment links, docs-first commands, Glass wiring, skills references, and Markdown route mapping.\n`,
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

function collectHeadingIds(source) {
	const slugger = new GithubSlugger();
	return new Set(
		[...withoutFencedCode(source).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) =>
			slugger.slug(visibleHeadingText(match[1])),
		),
	);
}

function withoutFencedCode(source) {
	return source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}

function visibleHeadingText(source) {
	return source
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "");
}

function assertInternalFragment(sourceFile, target, encodedFragment, headingIdsByPage) {
	let fragment;
	try {
		fragment = decodeURIComponent(encodedFragment);
	} catch {
		assert.fail(`${sourceFile} contains invalid encoded fragment #${encodedFragment}.`);
	}
	const headingIds = headingIdsByPage.get(target);
	assert(
		headingIds?.has(fragment),
		`${sourceFile} links to missing internal heading ${target}#${fragment}.`,
	);
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
