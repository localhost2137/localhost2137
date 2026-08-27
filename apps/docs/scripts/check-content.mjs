import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import {
	markdownRouteForPage,
	rewriteLLMIndexLinks,
	rewriteMarkdownPageLinks,
} from "../lib/markdown-routes.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsRoot, "content/docs");
const repositoryRoot = resolve(docsRoot, "../..");
const nativeBuildPermission = "allowBuilds:\n  better-sqlite3: true";

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
const repositoryIgnore = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
assert(repositoryIgnore.split("\n").includes(".localhost2137/"));
assert(
	security?.includes(titledCodeBlock("text", ".gitignore", ".localhost2137/\n")),
	"Security reference must lead with the repository's exact storage ignore rule.",
);
assert.equal(
	security?.match(/```[a-z]+[^\n]*\n/)?.[0],
	'```text title=".gitignore"\n',
	"Security reference must lead with a safe project file.",
);
assert(security?.includes("The runtime bearer token does not protect provider-shaped routes"));
assert(/There is no process, filesystem, or\s+network sandbox/.test(security ?? ""));
assert(security?.includes('{ "data": { "status": "ok", "version": "v1" } }'));
assert(security?.includes("curl --silent http://127.0.0.1:2137/_/v1/health"));
assert(!security?.includes("authorization: Bearer"));
const runtimeHttpApplication = await readFile(
	join(repositoryRoot, "packages/localhost2137/src/http/runtime-http-application.ts"),
	"utf8",
);
const controlApi = await readFile(
	join(repositoryRoot, "packages/localhost2137/src/control/control-api.ts"),
	"utf8",
);
assert(runtimeHttpApplication.includes('app.route("/_/v1", input.control)'));
assert(controlApi.includes('app.get("/health", () => success({ status: "ok", version: "v1" }))'));
assert(security?.includes("Ordinary string values and the log"));
assert(security?.includes("message pass through unchanged"));
assert(security?.includes("`localhost env` and `localhost run` do not inject the control token"));
assert(security?.includes("It does not\ncontain a same-user process"));
assert(security?.includes("separate OS/process account or in an isolated CI boundary"));
assert(security?.includes("same user is not\nisolation"));
assert(!security?.includes("keeps application compromise"));
const testedLogAttributes = {
	authorization: "[REDACTED]",
	circular: "[CIRCULAR]",
	nested: { payload: "[OMITTED]", token: "[REDACTED]", visible: "safe" },
};
assert(
	security?.includes(
		titledCodeBlock("json", "tested log attributes", JSON.stringify(testedLogAttributes, null, 2)),
	),
	"Security log example must match the tested redaction result.",
);
const structuredLogTests = await readFile(
	join(repositoryRoot, "packages/localhost2137/test/kernel/structured-log.test.ts"),
	"utf8",
);
for (const evidence of [
	'authorization: "[REDACTED]"',
	'circular: "[CIRCULAR]"',
	'nested: { payload: "[OMITTED]", token: "[REDACTED]", visible: "safe" }',
]) {
	assert(structuredLogTests.includes(evidence), `Security redaction evidence drifted: ${evidence}`);
}
const diagnosticPage = content.get("diagnosing.mdx");
const removedBeforeSharing = sourceSliceBefore(
	diagnosticPage ?? "",
	"## Removed before sharing",
	"\n```",
);
assert(
	security?.includes(titledCodeBlock("md", "share-check.md", removedBeforeSharing)),
	"Security sharing check must match the canonical diagnostic report section.",
);
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

const skillDirectories = [
	join(repositoryRoot, "skills/use-localhost2137"),
	join(repositoryRoot, "skills/build-localhost2137-plugin"),
];
for (const directory of skillDirectories) {
	for (const file of (await listFiles(directory)).filter((path) => path.endsWith(".md"))) {
		const source = await readFile(file, "utf8");
		for (const fence of source.matchAll(/```sh\n([\s\S]*?)```/g)) {
			assert(
				!/<[^>\n]+>/.test(fence[1]),
				`${relative(repositoryRoot, file)} contains an angle-bracket shell placeholder.`,
			);
		}
	}
}
for (const skillPath of [
	"skills/use-localhost2137/SKILL.md",
	"skills/build-localhost2137-plugin/SKILL.md",
]) {
	const source = await readFile(join(repositoryRoot, skillPath), "utf8");
	assert(!/\b(Slack|Stripe)\b/.test(source), `${skillPath} must remain service-generic.`);
}
const pluginContractSkill = await readFile(
	join(repositoryRoot, "skills/build-localhost2137-plugin/references/public-contract.md"),
	"utf8",
);
assert(pluginContractSkill.includes("It may run again after an interrupted attempt"));
assert(!pluginContractSkill.includes("Initialize empty service storage once"));
const runtimeInterfacesSkill = await readFile(
	join(repositoryRoot, "skills/use-localhost2137/references/runtime-interfaces.md"),
	"utf8",
);
assert(runtimeInterfacesSkill.includes("A create `ControlApiError` is an authoritative rejection"));
assert(runtimeInterfacesSkill.includes("A transport or protocol create failure is uncertain"));
assert(runtimeInterfacesSkill.includes("primary failure first and as `cause`"));

const introduction = content.get("index.mdx");
assert(introduction?.includes("title: What localhost2137 is"));

const testBoundaries = content.get("test-boundaries.mdx");
for (const [title, path] of [
	["test/read-workspace-stub.test.ts", "examples/getting-started/test/read-workspace-stub.test.ts"],
	["test/read-workspace.test.ts", "examples/getting-started/test/read-workspace.test.ts"],
]) {
	const example = await readFile(join(repositoryRoot, path), "utf8");
	assert(
		testBoundaries?.includes(titledCodeBlock("ts", title, example)),
		`Test-boundary contrast must match ${path}.`,
	);
}
assert(testBoundaries?.includes("This is an evidence ladder, not a quality ladder"));
assert(testBoundaries?.includes("Keep external checks for external claims"));

const operationsAndApis = content.get("operations-and-apis.mdx");
const operationBoundaryTest = await readFile(
	join(repositoryRoot, "examples/getting-started/test/owned-runtime.test.ts"),
	"utf8",
);
assert(
	operationsAndApis?.includes(
		titledCodeBlock("ts", "test/owned-runtime.test.ts", operationBoundaryTest),
	),
	"Operations concept must match the checked control-write/provider-read test.",
);
assert.equal(
	operationsAndApis.match(/```[a-z]+[^\n]*\n/)?.[0],
	'```ts title="test/owned-runtime.test.ts"\n',
	"Operations concept must lead with the checked boundary test.",
);
assert(operationsAndApis?.includes('fetch(new URL("users.list"'));
assert(operationsAndApis?.includes('instance.slack.createUser({ name: "Grace" })'));
assert(
	operationsAndApis?.includes("direct test-side `fetch` does not prove an application adapter"),
);
assert(!operationsAndApis?.includes("`listUsers`"));

const gettingStarted = content.get("getting-started.mdx");
assert(gettingStarted, "Getting started content is missing.");
const crashCourseConfig = await readFile(
	join(repositoryRoot, "examples/getting-started/localhost.config.ts"),
	"utf8",
);
const crashCourseApp = await readFile(
	join(repositoryRoot, "examples/getting-started/src/read-workspace.ts"),
	"utf8",
);
const crashCourseOwnedTest = await readFile(
	join(repositoryRoot, "examples/getting-started/test/owned-runtime.test.ts"),
	"utf8",
);
const configBlock = titledCodeBlock("ts", "localhost.config.ts", crashCourseConfig);
const storageIgnoreBlock = titledCodeBlock("text", ".gitignore", ".localhost2137/\n");
assert(
	gettingStarted.includes(configBlock),
	"Getting started config must match the executable example.",
);
assert.equal(
	gettingStarted.match(/```[^\n]*\n/)?.[0],
	'```ts title="localhost.config.ts"\n',
	"The complete localhost.config.ts must be the first getting-started artifact.",
);
assert(
	gettingStarted.includes(titledCodeBlock("ts", "src/read-workspace.ts", crashCourseApp)),
	"Getting started application must match the executable example.",
);
assert(
	gettingStarted.includes(
		titledCodeBlock("ts", "test/owned-runtime.test.ts", crashCourseOwnedTest),
	),
	"Getting started owned test must match the executable example.",
);
let previousCrashCourseStep = -1;
for (const step of [
	configBlock,
	"pnpm add -D localhost2137 @localhost2137/slack hono@^4.13.4 zod@^4.4.3 vitest",
	storageIgnoreBlock,
	"pnpm exec localhost dev",
	"pnpm exec localhost seed",
	titledCodeBlock("ts", "src/read-workspace.ts", crashCourseApp),
	"pnpm exec localhost env --format json",
	"pnpm exec localhost run -- pnpm dev",
	"pnpm exec localhost describe slack --json",
	"pnpm exec localhost exec slack send-message",
	"pnpm exec localhost instance create review --seed",
	"pnpm exec localhost clock advance 1h --instance review --json",
	titledCodeBlock("ts", "test/owned-runtime.test.ts", crashCourseOwnedTest),
]) {
	const position = gettingStarted.indexOf(step);
	assert(
		position > previousCrashCourseStep,
		`Getting started step is missing or out of order: ${step}`,
	);
	previousCrashCourseStep = position;
}
assert(gettingStarted.includes("not a provider-issued API key"));
assert(gettingStarted.includes("control token never enters the application process"));
assert(gettingStarted.includes("The Slack setup above has no time-driven work"));
assert(gettingStarted.includes("same plugin config and callback destination"));

const existingApplication = content.get("existing-application.mdx");
assert(
	existingApplication?.includes(titledCodeBlock("ts", "src/read-workspace.ts", crashCourseApp)),
	"Existing-application guide must use the executable application boundary.",
);
for (const command of [
	"pnpm exec localhost seed",
	"pnpm exec localhost env --format json",
	"pnpm exec localhost run -- pnpm dev",
	"pnpm exec localhost describe slack --json",
	"pnpm exec localhost exec slack create-user --name Grace --json",
	"pnpm exec localhost logs slack --tail 50 --json",
	"pnpm exec localhost instance create review-42 --seed",
	"--instance review-42 --name Lin --json",
	"pnpm exec localhost instance destroy review-42",
]) {
	assert(
		existingApplication?.includes(command),
		`Existing-application guide is missing the concrete workflow command: ${command}`,
	);
}
assert(!existingApplication?.includes("replace-with-"));
assert(!existingApplication?.includes("list-messages"));
assert(
	existingApplication?.includes("only for the crash-course config's first unseeded dev world"),
);

const seeding = content.get("seeding.mdx");
const seedingConfig = await readFile(
	join(repositoryRoot, "examples/getting-started/test/fixtures/seeding-config.ts"),
	"utf8",
);
const seedLifecycleTest = await readFile(
	join(repositoryRoot, "examples/getting-started/test/seed-lifecycle.test.ts"),
	"utf8",
);
assert(
	seeding?.includes(titledCodeBlock("ts", "test/fixtures/seeding-config.ts", seedingConfig)),
	"Seeding config must match the executable example.",
);
assert(
	seeding?.includes(titledCodeBlock("ts", "test/seed-lifecycle.test.ts", seedLifecycleTest)),
	"Seeding lifecycle test must match the executable example.",
);
for (const command of [
	"pnpm exec localhost --config test/fixtures/seeding-config.ts dev",
	"instance create seed-guide",
	"seed --instance seed-guide",
	"instance reset seed-guide",
	"instance reset seed-guide --seed",
	"instance destroy seed-guide",
]) {
	assert(seeding?.includes(command), `Seeding guide is missing the owned CLI step: ${command}`);
}
assert.equal(
	seeding?.match(/pnpm exec localhost --config test\/fixtures\/seeding-config\.ts/g)?.length,
	8,
	"Every seeding daemon and CLI command must select the checked config explicitly.",
);
assert(seeding?.includes("Another in-place seed is refused"));
assert(seeding?.includes("no partially seeded new instance becomes addressable"));
assert(seeding?.includes("restores the prior world when it can"));

const diagnosing = content.get("diagnosing.mdx");
let previousDiagnosticStep = -1;
for (const step of [
	"pnpm exec localhost doctor --json",
	"pnpm exec localhost dev",
	"pnpm exec localhost describe slack --instance dev --json",
	"pnpm exec localhost env --instance dev --format json",
	"pnpm exec localhost run --instance dev -- pnpm dev",
	"pnpm exec localhost logs slack --instance dev --tail 50 --json",
]) {
	const position = diagnosing?.indexOf(step) ?? -1;
	assert(position > previousDiagnosticStep, `Diagnosing step is missing or out of order: ${step}`);
	previousDiagnosticStep = position;
}
assert(diagnosing?.includes("serialized diagnostic identifies the selected config path"));
assert(diagnosing?.includes('```md title="diagnostic-report.md"'));
assert(diagnosing?.includes("## Removed before sharing"));
assert(diagnosing?.includes("Runtime control token"));
assert(diagnosing?.includes("`droppedEntries`"));
assert(
	diagnosing?.includes(
		"Absence keeps the failure at the application boundary; a present entry can be traced inside the provider-shaped boundary.",
	),
);
assert(!diagnosing?.includes("replace-with-"));
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
for (const command of [
	"pnpm exec localhost describe slack --instance dev --json",
	"pnpm exec localhost exec slack create-user --instance dev --name Grace --json",
	"LOCALHOST_INSTANCE=dev pnpm exec localhost describe slack --json",
	"pnpm exec localhost exec slack create-user --name Lin --admin=false --json",
	'--input-json \'{"channel":"general","from":"Ada","text":"ready"}\' --json',
	"pnpm exec localhost instance create review",
	"pnpm exec localhost run --instance dev -- pnpm test",
	"pnpm exec localhost clock advance 2h --instance dev --json",
]) {
	assert(cli?.includes(command), `CLI reference is missing the concrete command: ${command}`);
}
assert(!cli?.includes("LOCALHOST_INSTANCE=review pnpm"));
let previousCliLifecycleStep = -1;
for (const step of [
	"pnpm exec localhost instance create review\n",
	"pnpm exec localhost instance list --json",
	"pnpm exec localhost seed --instance review",
	"pnpm exec localhost instance reset review\n",
	"pnpm exec localhost instance reset review --seed",
	"pnpm exec localhost instance destroy review",
]) {
	const position = cli?.indexOf(step) ?? -1;
	assert(
		position > previousCliLifecycleStep,
		`CLI lifecycle step is missing or out of order: ${step}`,
	);
	previousCliLifecycleStep = position;
}
assert(!cli?.includes("pnpm exec localhost seed --instance dev"));
assert(!cli?.includes("replace-with-"));
assert(cli?.includes("owner-approved documentation-first contracts awaiting implementation"));
assert(cli?.includes("Only `/_/v1/health` is unauthenticated"));
assert(cli?.includes("This Bash example"));
const configuration = content.get("configuration.mdx");
assert(
	configuration?.includes(titledCodeBlock("ts", "localhost.config.ts", crashCourseConfig)),
	"Configuration reference must lead from the checked complete crash-course config.",
);
for (const terminal of [
	"Terminal 1:\n\n```sh\npnpm exec localhost dev\n```",
	"Terminal 2:\n\n```sh\npnpm exec localhost seed\npnpm exec localhost env --instance dev --format json\n```",
]) {
	assert(configuration?.includes(terminal), `Configuration is missing runnable split: ${terminal}`);
}
assert.equal(
	configuration?.match(/```[a-z]+[^\n]*\n/)?.[0],
	'```ts title="localhost.config.ts"\n',
	"Configuration reference must lead with a complete config file.",
);
assert(
	configuration?.includes(titledCodeBlock("ts", "test/fixtures/seeding-config.ts", seedingConfig)),
	"Configuration scenario seed must match its checked fixture.",
);
assert(configuration?.includes("The `port: 0` used by `createTestRuntime"));
assert(configuration?.includes("Renaming a key is therefore not a migration"));
assert(configuration?.includes("The runtime's `received` diagnostic records the value's type"));
assert(configuration?.includes("`.env` below `storage.dir`"));
assert(configuration?.includes("Removing or renaming a service while it still owes"));
assert(!configuration?.includes("in-process tests require port `0`"));
const testing = content.get("testing.mdx");
for (const [title, path] of [
	["test/owned-runtime.test.ts", "examples/getting-started/test/owned-runtime.test.ts"],
	["test/subscription.test.ts", "examples/stripe-sdk/test/subscription.test.ts"],
	["test/runtime-connection.ts", "examples/testing-parallel/test/runtime-connection.ts"],
	["test/global-setup.ts", "examples/testing-parallel/test/global-setup.ts"],
	["test/owned-instance.ts", "examples/testing-parallel/test/owned-instance.ts"],
	["test/worker-contract.ts", "examples/testing-parallel/test/worker-contract.ts"],
]) {
	const example = await readFile(join(repositoryRoot, path), "utf8");
	assert(
		testing?.includes(titledCodeBlock("ts", title, example)),
		`Testing guide must match the checked example ${path}.`,
	);
}
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
const clockTransitionTest = await readFile(
	join(repositoryRoot, "examples/getting-started/test/clock-transition.test.ts"),
	"utf8",
);
assert(
	virtualTime?.includes(
		titledCodeBlock("ts", "test/clock-transition.test.ts", clockTransitionTest),
	),
	"Virtual-time reference must match the checked public transition test.",
);
assert.equal(
	virtualTime?.match(/```[a-z]+[^\n]*\n/)?.[0],
	'```ts title="test/clock-transition.test.ts"\n',
	"Virtual-time reference must lead with the checked public transition.",
);
const pendingClockEnvelope = {
	error: {
		code: "INSTANCE_MUTATION_COMMITTED",
		correlationId: "adapter-correlation",
		details: {
			advanceId: "advance_safe",
			from: "2026-01-01T00:00:00.000Z",
			mode: "pinned",
			reconciliationPending: true,
			to: "2026-01-01T00:00:01.000Z",
		},
		message: "The clock moved, but time reconciliation remains pending.",
	},
};
assert(
	virtualTime?.includes(
		titledCodeBlock(
			"json",
			"tested control response",
			JSON.stringify(pendingClockEnvelope, null, 2),
		),
	),
	"Virtual-time committed failure must match the tested public control envelope.",
);
const controlErrorMappingTests = await readFile(
	join(repositoryRoot, "packages/localhost2137/test/control/control-error-mapping.test.ts"),
	"utf8",
);
for (const field of [
	'code: "INSTANCE_MUTATION_COMMITTED"',
	'correlationId: "adapter-correlation"',
	'advanceId: "advance_safe"',
	"reconciliationPending,",
	'from: "2026-01-01T00:00:00.000Z"',
	'to: "2026-01-01T00:00:01.000Z"',
]) {
	assert(
		controlErrorMappingTests.includes(field),
		`Clock error evidence lost tested field: ${field}`,
	);
}
assert(virtualTime?.includes("Task tracking is a separate concern"));
assert(virtualTime?.includes("`01s`"));
assert(virtualTime?.includes("safe integer of milliseconds"));
assert(virtualTime?.includes("In real mode, they add 60 days"));
assert(virtualTime?.includes("does not expose the underlying cause"));
assert(!virtualTime?.includes("Fix the reported plugin"));
assert(!virtualTime?.includes("arrange durable plugin state"));
const callbacks = content.get("callbacks.mdx");
for (const [title, path] of [
	["src/bot.ts", "examples/slack-ping-bot/src/bot.ts"],
	["test/ping-pong.test.ts", "examples/slack-ping-bot/test/ping-pong.test.ts"],
]) {
	const example = await readFile(join(repositoryRoot, path), "utf8");
	assert(
		callbacks?.includes(titledCodeBlock("ts", title, example)),
		`Callback concept must match the checked example ${path}.`,
	);
}
assert(
	callbacks?.indexOf("await bot.start()") < callbacks?.indexOf("await instance.slack.sendMessage"),
);
assert(callbacks?.includes('expect(messages.map(({ text }) => text)).toEqual(["pong", "ping"])'));
assert(callbacks?.includes("timeout and retry behavior"));
assert(callbacks?.includes("Those details are part of the plugin's compatibility surface"));
assert(callbacks?.includes("Separate instance storage never proves callback routing"));
assert(callbacks?.includes("When an installed plugin does"));
const instances = content.get("instances.mdx");
const instanceIsolationTest = await readFile(
	join(repositoryRoot, "examples/getting-started/test/instance-isolation.test.ts"),
	"utf8",
);
assert(
	instances?.includes(
		titledCodeBlock("ts", "test/instance-isolation.test.ts", instanceIsolationTest),
	),
	"Instances concept must match the checked two-world isolation proof.",
);
assert(instances?.includes("expect(firstUrl.origin).toBe(secondUrl.origin)"));
assert(instances?.includes("expect(firstUrl.pathname).not.toBe(secondUrl.pathname)"));
assert(
	instances?.includes(
		'readUserNames(second.slack.connection)).resolves.toEqual([\n\t\t\t\t\t"localhost2137-bot"',
	),
);
assert(instances?.indexOf("await second.destroy()") < instances?.indexOf("await first.destroy()"));
const determinism = content.get("determinism.mdx");
const stripeClockTests = await readFile(
	join(repositoryRoot, "plugins/stripe/test/clock-and-recovery.test.ts"),
	"utf8",
);
const clockContrast = sourceSliceBefore(
	stripeClockTests,
	'\tit("uses the same exact 30-day renewal boundaries in pinned and real-offset modes"',
	"\n});\n\nasync function startRuntime",
);
assert(
	determinism?.includes(
		titledCodeBlock("ts", "plugin semantic test (source excerpt)", clockContrast),
	),
	"Determinism concept must match the checked pinned-versus-real Stripe semantic test.",
);
assert.equal(
	determinism?.match(/```[a-z]+[^\n]*\n/)?.[0],
	'```ts title="plugin semantic test (source excerpt)"\n',
	"Determinism concept must lead with source-backed behavior.",
);
assert(determinism?.includes("**Controlled:**"));
assert(determinism?.includes("**Intentionally uncontrolled:**"));
assert(!/deterministic mode/i.test(determinism ?? ""));

const compatibility = content.get("compatibility.mdx");
const stripeSdkAdapter = await readFile(
	join(repositoryRoot, "examples/stripe-sdk/src/local-stripe.ts"),
	"utf8",
);
const stripeSdkTest = await readFile(
	join(repositoryRoot, "examples/stripe-sdk/test/subscription.test.ts"),
	"utf8",
);
const stripeSdkManifest = JSON.parse(
	await readFile(join(repositoryRoot, "examples/stripe-sdk/package.json"), "utf8"),
);
assert.equal(stripeSdkManifest.dependencies.stripe, "22.5.0");
assert(compatibility?.includes("pnpm add stripe@22.5.0"));
assert(
	compatibility?.includes(titledCodeBlock("ts", "src/local-stripe.ts", stripeSdkAdapter)),
	"Compatibility concept must match the checked official SDK adapter.",
);
assert(
	compatibility?.includes(titledCodeBlock("ts", "test/subscription.test.ts", stripeSdkTest)),
	"Compatibility concept must match the checked official SDK workflow.",
);
assert(compatibility?.includes('client.customers.retrieve("cus_missing")'));
assert(compatibility?.includes('code: "customer_missing"'));
assert(compatibility?.includes('type: "StripeInvalidRequestError"'));
assert(compatibility?.includes("With Stripe Node `22.5.0`, this checked path establishes"));
assert(compatibility?.includes("It does not claim that the"));
assert(compatibility?.includes("application-facing Stripe API created those two resources"));
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
assert(pluginUsing?.includes("pnpm add -D localhost2137 <plugin-package> hono@^4.13.4 zod@^4.4.3"));
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
	firstPartySlack?.includes(
		"pnpm add -D localhost2137 @localhost2137/slack hono@^4.13.4 zod@^4.4.3",
	),
);
assert(firstPartySlack?.includes("pnpm add @slack/bolt@5.0.0"));
assert(firstPartySlack?.includes(nativeBuildPermission));
assert(!/^pnpm add @slack\/bolt\s*$/m.test(firstPartySlack ?? ""));
assert(
	firstPartySlack?.includes("Public Web API channel arguments deliberately require stored IDs"),
);
assert(firstPartySlack?.includes("ascending stored-ID order"));
assert(!firstPartySlack?.includes("users in creation order"));
assert(firstPartySlack?.includes("first character must be an ASCII lowercase letter or digit"));
assert(firstPartySlack?.includes("There are at most four attempts"));
assert(firstPartySlack?.includes("The tested client is `@slack/bolt` 5.0.0"));
assert(firstPartySlack?.includes("Messages and pending deliveries cannot be seeded"));
assert(firstPartySlack?.includes("message timestamps come from the instance clock"));
assert(!/\bdeterministic\b/i.test(firstPartySlack ?? ""));
const firstPartyStripe = content.get("first-party/stripe.mdx");
assert(
	firstPartyStripe?.includes(
		"pnpm add -D localhost2137 @localhost2137/stripe hono@^4.13.4 zod@^4.4.3",
	),
);
assert(firstPartyStripe?.includes("pnpm add stripe@22.5.0"));
assert(firstPartyStripe?.includes(nativeBuildPermission));
assert(!/^pnpm add stripe\s*$/m.test(firstPartyStripe ?? ""));
assert(firstPartyStripe?.includes("Products and prices are intentionally read-only through HTTP"));
assert(firstPartyStripe?.includes("Stripe Node 22.5.0"));
assert(firstPartyStripe?.includes("this plugin does not schedule a retry"));
assert(firstPartyStripe?.includes("The helper verifies the HMAC digest only"));
assert(firstPartyStripe?.includes("With a pinned clock, a fresh instance"));
assert(!/\bdeterministic\b/i.test(firstPartyStripe ?? ""));

for (const [readmePath, installCommand, clientCommand] of [
	[
		"plugins/slack/README.md",
		"pnpm add -D localhost2137 @localhost2137/slack hono@^4.13.4 zod@^4.4.3",
		"pnpm add @slack/bolt@5.0.0",
	],
	[
		"plugins/stripe/README.md",
		"pnpm add -D localhost2137 @localhost2137/stripe hono@^4.13.4 zod@^4.4.3",
		"pnpm add stripe@22.5.0",
	],
]) {
	const source = await readFile(join(repositoryRoot, readmePath), "utf8");
	assert(
		source.includes(installCommand),
		`${readmePath} must include its consumer install command.`,
	);
	assert(
		source.includes(clientCommand),
		`${readmePath} must include its application client command.`,
	);
	assert(
		source.includes(nativeBuildPermission),
		`${readmePath} must include the better-sqlite3 build permission.`,
	);
	assert(!/^pnpm add (?:@slack\/bolt|stripe)\s*$/m.test(source));
	assert(!source.includes("pnpm exec vitest run plugins/"));
	assert(!source.includes("../../examples/"));
	assert(!/\bdeterministic\b/i.test(source));
}
const slackReadme = await readFile(join(repositoryRoot, "plugins/slack/README.md"), "utf8");
assert(!/upgrades relocate|v0\.1|preserved-/.test(slackReadme));
const workspacePolicy = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
assert(workspacePolicy.includes(nativeBuildPermission));
const packageSmoke = await readFile(join(repositoryRoot, "scripts/package-smoke.mjs"), "utf8");
assert(packageSmoke.includes('"allowBuilds:\\n  better-sqlite3: true\\n'));
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
	"---Add services---",
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
assert.equal(
	packageManifest.scripts.check,
	"pnpm check:content && pnpm build && pnpm check:routes",
);
assert.equal(packageManifest.scripts["check:routes"], "node scripts/check-built-routes.mjs");
assert.equal(packageManifest.scripts.dev, "react-router dev");
assert.equal(packageManifest.scripts.deploy, "pnpm build && wrangler deploy");

const repositoryManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
assert.equal(repositoryManifest.scripts["docs:check"], "pnpm --filter @localhost2137/docs check");
assert(repositoryManifest.scripts.check.includes("pnpm docs:check"));
assert.equal(
	repositoryManifest.scripts["pack:check"],
	"pnpm clean && tsc -b && pnpm --filter './packages/*' --filter './plugins/*' pack --dry-run",
);

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

const markdownLinkFixture = [
	"[callback](/callbacks#parallel-receivers-require-a-routing-rule)",
	"[root](/)",
	"[llms](/llms.txt)",
	"[unknown](/not-a-doc#fragment)",
	"[external](https://example.test/callbacks)",
].join("\n");
assert.equal(
	rewriteMarkdownPageLinks(markdownLinkFixture, pageUrls),
	[
		"[callback](/callbacks.md#parallel-receivers-require-a-routing-rule)",
		"[root](/index.md)",
		"[llms](/llms.txt)",
		"[unknown](/not-a-doc#fragment)",
		"[external](https://example.test/callbacks)",
	].join("\n"),
	"Markdown resources must rewrite only known docs links and preserve suffixes.",
);

const llmsIndexRoute = await readFile(join(docsRoot, "app/routes/llms-index.ts"), "utf8");
assert(llmsIndexRoute.includes("rewriteLLMIndexLinks"));
const llmsFullRoute = await readFile(join(docsRoot, "app/routes/llms-full.ts"), "utf8");
assert(llmsFullRoute.includes("getSidebarPages().map(getLLMText)"));
assert(!llmsFullRoute.includes("source.getPages()"));
const getLLMTextSource = await readFile(join(docsRoot, "lib/get-llm-text.ts"), "utf8");
assert(getLLMTextSource.includes("rewriteMarkdownPageLinks"));
const docsSource = await readFile(join(docsRoot, "lib/source.ts"), "utf8");
assert(docsSource.includes("flattenTree(source.getPageTree().children)"));
assert(docsSource.includes("every documentation page exactly once"));
for (const route of [
	"app/routes/search.ts",
	"app/routes/llms-index.ts",
	"app/routes/llms-full.ts",
	"app/routes/markdown.ts",
	"lib/markdown-resource.ts",
	"scripts/check-built-routes.mjs",
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

function titledCodeBlock(language, title, source) {
	return `\`\`\`${language} title="${title}"\n${source.trimEnd()}\n\`\`\``;
}

function sourceSliceBefore(source, start, before) {
	const startIndex = source.indexOf(start);
	assert.notEqual(startIndex, -1, `Source excerpt start is missing: ${start}`);
	const endIndex = source.indexOf(before, startIndex);
	assert.notEqual(endIndex, -1, `Source excerpt end is missing after: ${start}`);
	return source.slice(startIndex, endIndex);
}

async function assertMissing(path) {
	try {
		await access(path);
		assert.fail(`Retired Next.js file still exists: ${relative(docsRoot, path)}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}
