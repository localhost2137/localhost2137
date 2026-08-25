localhost2137

What it is

localhost2137 is a local runtime for stateful emulators of external developer services.

It is not a generic mock server.

The goal is to make services such as Slack, Stripe, Discord, GitHub, Twilio, Resend, etc. available as local, programmable, disposable versions of themselves.

A user should be able to install plugins:

npm install @localhost2137/slack
npm install @localhost2137/stripe

configure them in:

localhost.config.ts

and run everything through a shared local runtime on port 2137.

For example:

http://localhost:2137/slack
http://localhost:2137/stripe

The runtime owns common infrastructure. Plugins implement the actual behavior of individual services.

⸻

Why this should exist

The strongest reason is agentic coding.

Coding agents are very capable when everything they need exists locally:

* filesystem
* source code
* shell
* local servers
* tests
* databases

They become much less autonomous as soon as development depends on an external API.

Building a Slack bot may require:

* a real workspace
* an app
* credentials
* OAuth scopes
* event subscriptions
* users and channels
* manually triggering events

The same general problem exists with Stripe, Discord, Twilio, GitHub and many other APIs.

A coding agent can write the integration, but often cannot independently create and manipulate the external world required to test it.

localhost2137 gives the agent its own local version of that world.

Instead of asking the developer for credentials or access, the agent can do things such as:

localhost exec slack user create --name alice
localhost exec slack channel create --name general
localhost exec slack message send --channel general --from alice --text "ping"

It can then inspect the result, modify the application, trigger another event and repeat.

The important property is not merely that APIs are mocked.

The important property is that the entire external environment becomes:

* local
* controllable
* disposable
* inspectable
* deterministic
* scriptable

A useful mental model is:

Give coding agents their own internet.

Or, more technically:

A runtime for local service emulators.

⸻

Core architecture

The runtime should be small.

Plugins should use normal ecosystem tools wherever possible instead of localhost2137 inventing replacements for them.

A plugin owns:

* its emulated HTTP API
* its control operations
* its configuration schema
* its own persistence implementation
* setup/bootstrap/migration logic
* service-specific business logic

The localhost2137 runtime owns:

* plugin lifecycle
* routing
* configuration loading
* isolated storage locations
* instance lifecycle
* virtual time
* execution of control operations
* generated CLI
* test integration
* later: snapshots, forks and other deterministic runtime features

Conceptually:

localhost2137 runtime
│
├── Slack plugin
│   ├── API
│   ├── operations
│   ├── config
│   ├── state
│   └── service logic
│
├── Stripe plugin
│   ├── API
│   ├── operations
│   ├── config
│   ├── state
│   └── service logic
│
└── shared runtime capabilities
    ├── storage
    ├── clock
    ├── instances
    ├── lifecycle
    └── execution

⸻

HTTP APIs: use Hono

localhost2137 should not invent an HTTP routing framework.

Plugins should define their API using Hono.

Hono is especially appropriate because a Hono application represents routing logic rather than necessarily owning the underlying HTTP server.

A plugin can therefore return a Hono application and localhost2137 can mount it under its own routing structure.

Example:

const app = new Hono()
app.post("/api/chat.postMessage", ...)
app.get("/api/users.list", ...)

localhost2137 can expose that as:

http://localhost:2137/slack/api/chat.postMessage
http://localhost:2137/slack/api/users.list

The runtime can add prefixes, middleware, logging, instance selection or other shared behavior without the plugin owning the server.

⸻

Configuration: use Zod

Plugins define their configuration using Zod.

Example:

const config = z.object({
  token: z.string(),
  defaultSeed: z.string().optional(),
})

Users configure installed plugins in:

localhost.config.ts

Example:

import { defineConfig } from "localhost2137"
import slack from "@localhost2137/slack"
import stripe from "@localhost2137/stripe"
export default defineConfig({
  plugins: [
    slack({
      token: "xoxb-local",
    }),
    stripe({
      apiKey: "sk_test_local",
    }),
  ],
})

Configuration should be ordinary TypeScript.

Agents can therefore inspect and edit it directly.

⸻

Persistence: own the lifecycle, not the database

localhost2137 should not invent a database abstraction.

A plugin should be free to use:

* SQLite
* Drizzle
* Prisma
* raw SQL
* JSON files
* arbitrary local files
* another embedded database

The runtime only provides a managed, isolated place where the plugin can persist data.

Conceptually:

~/.localhost2137/
└── instances/
    └── dev/
        ├── slack/
        │   └── ...
        └── stripe/
            └── ...

The exact physical layout is an implementation detail.

Plugins should ideally receive a storage capability rather than hardcoding global paths.

For example:

ctx.storage.path("database.sqlite")

This keeps plugins portable if storage later comes from:

* a local directory
* tmpfs
* Docker
* CI
* a remote environment
* snapshot storage

The runtime should expose lifecycle hooks such as:

setup
bootstrap
migrate
reset

but the plugin decides what those hooks actually do.

localhost2137 manages where and when state exists.

The plugin manages how its state works.

⸻

Public API vs control plane

Every emulator has two fundamentally different interfaces.

Public emulated API

This is what the application under development sees.

For Slack this might be:

POST /api/chat.postMessage
GET /api/users.list

It should behave as closely as practical to the real external API.

Control operations

These exist for developers, tests and coding agents.

Examples:

createUser
createChannel
sendMessage
emitEvent
setPresence
disconnectUser

These do not need to correspond to real Slack endpoints.

They are privileged ways to manipulate the simulated world.

This distinction is important.

The HTTP API answers:

How does my application interact with Slack?

Operations answer:

How can a developer, test or coding agent control the fake Slack world?

⸻

Operations, not custom CLI commands

Plugins should not primarily define CLI commands.

They should define typed operations.

Example:

const createUser = defineOperation({
  description: "Create a Slack user",
  input: z.object({
    name: z.string().describe("User display name"),
    email: z.string().email().optional(),
    admin: z.boolean().default(false),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
  }),
  async run(ctx, input) {
    // mutate the emulator state
  },
})

A plugin exposes these operations:

definePlugin({
  api,
  operations: {
    createUser,
    createChannel,
    sendMessage,
  },
})

The operation is the source of truth.

CLI is only one adapter over it.

⸻

CLI generation

For now, localhost2137 should avoid a custom CLI-definition DSL.

The Zod input schema should be enough to generate a reasonable CLI automatically.

For example:

z.object({
  name: z.string(),
  admin: z.boolean().default(false),
  email: z.string().optional(),
})

can become approximately:

localhost exec slack create-user \
  --name alice \
  --email alice@example.com \
  --admin

Conventions can cover most cases:

createUser      → create-user
string          → --name <value>
number          → --count <value>
boolean         → --admin
optional        → optional flag
default         → optional flag with default
enum            → constrained option
array           → repeated option

There is no need initially for plugin authors to specify positional arguments, aliases or custom CLI formatting.

If real usage later proves that richer CLI presentation is necessary, metadata can be added without changing the underlying operation model.

The important part is to avoid putting business logic inside CLI handlers.

⸻

Programmatic reuse

Operations must be callable directly from JavaScript/TypeScript.

The same operation that powers:

localhost exec slack create-user --name alice

should also power:

const localhost = await createInstance()
const alice = await localhost.slack.createUser({
  name: "alice",
})

There should not be separate implementations for CLI and tests.

Both paths ultimately call the same operation:

createUser.run(ctx, input)

This makes the control plane useful from:

* CLI
* unit tests
* integration tests
* Playwright
* Vitest/Jest
* scripts
* coding agents
* later, possibly MCP

⸻

Machine-friendly operations

Operations should return data rather than print things.

Bad:

async run() {
  console.log("Created user!")
}

Good:

async run() {
  return {
    id: "U001",
    name: "alice",
  }
}

The CLI adapter can decide how to render it.

Human mode:

Created user alice (U001)

Machine mode:

localhost exec slack create-user --name alice --json
{
  "id": "U001",
  "name": "alice"
}

Agent-friendly behavior should be a core design constraint:

* --json where appropriate
* stable exit codes
* no required interactive prompts
* structured errors
* predictable command names
* good --help
* discoverable operations

⸻

Introspection and documentation

Because operations use Zod and carry descriptions, localhost2137 can understand the control surface of every plugin.

That enables automatic generation of:

* CLI help
* TypeScript types
* validation
* documentation
* JSON Schema
* operation discovery
* agent-facing documentation
* eventually MCP tools

For example, the runtime could expose an introspection command:

localhost exec slack --help

or machine-readable metadata:

localhost describe slack --json

The result could describe every available operation, its input schema and its output schema.

This is particularly useful for coding agents because they do not need service-specific knowledge hardcoded into localhost2137.

They can inspect the plugin themselves.

⸻

Virtual clock

Time should be a first-class runtime capability.

Plugins should be able to depend on:

ctx.clock.now()

rather than always reading wall-clock time directly.

This allows:

localhost clock advance 30d

For a Stripe emulator this could trigger:

* subscription renewals
* invoice generation
* retries
* expiration
* webhooks

For other services it can enable:

* scheduled jobs
* delayed events
* token expiration
* reminders
* retention logic
* timeout behavior

This is especially useful for agentic development because an agent can independently verify behavior that would normally take hours, days or months to occur.

⸻

Isolated instances

localhost2137 should support multiple independent emulator worlds.

For example:

instance dev
instance test-1
instance test-2
instance test-3

Each instance gets independent plugin state.

This makes it possible to run tests in parallel without sharing emulator state.

Example:

const localhost = await createInstance()
await localhost.slack.createUser({
  name: "alice",
})
// test...
await localhost.destroy()

A test runner should eventually be able to create many instances cheaply:

Vitest worker 1 → instance A
Vitest worker 2 → instance B
Vitest worker 3 → instance C
Vitest worker 4 → instance D

⸻

Determinism

Testing becomes much more powerful if localhost2137 controls more than storage.

Long term, useful runtime capabilities may include:

clock
IDs
randomness
instance state

For example, instead of every plugin generating arbitrary UUIDs, verified plugins could use:

ctx.ids.uuid()

This makes environments reproducible.

A failing agent or CI job could potentially report a deterministic reproduction seed rather than an opaque collection of state.

This does not need to exist in the first version, but the architecture should avoid making it impossible.

⸻

Snapshots and forks

A natural later capability is snapshotting an entire instance:

localhost snapshot create before-renewal
localhost clock advance 30d
localhost snapshot restore before-renewal

Programmatically:

const snapshot = await localhost.snapshot()

Even more useful is forking:

const base = await localhost.snapshot()
const a = await base.fork()
const b = await base.fork()
const c = await base.fork()

Many tests or coding agents could start from exactly the same world and then independently mutate it.

This could become particularly valuable for:

* parallel CI
* AI coding agents
* reproducing bugs
* expensive seed datasets

⸻

Agent-native design

The primary interfaces should remain ordinary developer primitives:

HTTP
CLI
TypeScript
filesystem

localhost2137 should not require a specific coding agent.

It should work with:

* Claude Code
* Codex
* Gemini CLI
* Cursor
* OpenCode
* future agents
* humans
* CI

MCP can later be generated as another adapter over operations, but it should not be the fundamental abstraction.

The architecture should be:

operation definitions
       │
       ├── TypeScript API
       ├── CLI
       ├── docs
       ├── JSON Schema
       └── optional MCP

rather than building the product around one agent protocol.

⸻

Plugin ecosystem

The long-term product is not a company manually maintaining hundreds of fake APIs.

The desired ecosystem looks more like:

@localhost2137/slack
@localhost2137/stripe
@localhost2137/github
@stripe/localhost2137
@some-company/internal-payments-emulator
community plugins

Plugins should be ordinary npm packages.

The runtime should make writing one feel similar in spirit to writing a Vite plugin: small contract, normal TypeScript ecosystem, minimal framework magic.

Third parties should be able to maintain their own emulators.

Eventually vendors themselves maintaining official plugins would be a success, not a threat.

⸻

Compatibility and verification

The code implementing a fake API is not necessarily the long-term moat.

A stronger layer is compatibility.

Potential future plugin states:

Community
Verified
Official

A verified emulator could be tested against a compatibility/conformance suite.

For example:

real Stripe API
      │
      ├── request corpus → real response
      │
      └── same requests → emulator response
                              │
                              ▼
                            diff

This could eventually produce meaningful compatibility information and detect API drift.

Vendors could maintain their own plugin while localhost2137 provides the runtime and compatibility infrastructure.

⸻

Business model

Local development should remain extremely easy and likely free.

The free runtime and plugin ecosystem are the distribution mechanism.

Potential paid layers exist around team and infrastructure needs rather than basic local emulation:

* CI environments
* hosted emulator instances
* shared state
* snapshots
* snapshot storage
* PR environments
* parallel agent environments
* compatibility monitoring
* API drift detection
* collaboration
* enterprise controls
* private/internal plugin infrastructure
* support and SLAs

There is also a possible vendor-side business model.

API companies such as Stripe or Slack may eventually pay for:

* official compatibility certification
* continuous conformance testing
* maintenance assistance
* distribution in the ecosystem
* developer-experience partnerships

But vendor sponsorship should not be required for the initial business to work.

The likely sequence is:

developers adopt it
→ teams depend on it
→ vendors notice it
→ official/vendor-maintained plugins become valuable

⸻

Competitive position

localhost2137 overlaps with several existing categories:

* emulate.dev
* LocalStack
* WireMock
* Mockoon
* Microcks
* vendor-specific local emulators
* MSW / Prism
* Testcontainers

The important distinction is not simply that localhost2137 is more modular.

The intended category is:

a general-purpose runtime contract for executable service emulators

Rather than a generic system that maps requests to mocked responses, a localhost2137 plugin can implement an actual small fake service:

business logic
state
database
events
HTTP API
control operations
time-dependent behavior

The closest conceptual comparison is something like:

LocalStack’s emulator/runtime model generalized beyond AWS, with a Vite-like npm plugin ecosystem and an agent-native control plane.

The major competitive risk is that individual features such as state, plugins, isolated environments or snapshots can be copied.

The stronger defensibility would come from the combination of:

* plugin contract
* ecosystem
* agent-friendly control operations
* deterministic runtime
* snapshots/forks
* compatibility infrastructure
* adoption as a common emulator standard

⸻

Product principles

Use existing tools whenever possible

Do not invent:

* an HTTP framework
* a schema language
* a database
* an ORM
* a filesystem abstraction larger than necessary
* a custom package format

Prefer:

Hono        → HTTP routing
Zod         → schemas and validation
npm         → plugin distribution
SQLite/etc. → plugin persistence
normal TS   → plugin implementation

Create localhost2137-specific abstractions only where localhost2137 introduces a genuinely new concept.

Operation is one such concept.

Plugins should be executable software

Do not constrain plugins to static mock definitions.

A plugin should be able to implement arbitrary stateful behavior.

Imports should not perform runtime side effects

Plugin definitions should be values that the runtime can inspect and mount.

Importing a plugin should not start servers, parse process.argv, write files or otherwise assume it owns the process.

The runtime owns lifecycle

Plugins should not need to know how the overall localhost2137 process is managed.

Everything important should be usable from code

If an action exists through CLI, tests should generally be able to execute the same underlying operation programmatically.

Design for agents without making the product agent-specific

Good agent UX usually also produces good automation and CI UX.

⸻

Naming

The brand is:

localhost2137

Use 2137 strongly in the identity:

GitHub organization: localhost2137
npm package:         localhost2137
plugin scope:        @localhost2137/*
default port:        2137

But the everyday interfaces should be shorter.

CLI:

localhost

Examples:

localhost dev
localhost exec slack create-user
localhost exec stripe create-customer
localhost clock advance 30d

Configuration:

localhost.config.ts

This separates the searchable/project identity from the daily interface.

localhost also works naturally as a programmatic concept:

const localhost = await createInstance()
await localhost.slack.createUser(...)
await localhost.stripe.createCustomer(...)
await localhost.clock.advance("30d")

⸻

Initial scope

Avoid building too many capabilities before the core abstraction is proven.

A strong first kernel is:

plugins
Hono API mounting
Zod config
operations
generated CLI
managed plugin storage
lifecycle hooks
virtual clock
isolated instances
programmatic testing API

Useful initial plugins:

Slack

Demonstrates:

* events
* control operations
* agent autonomy
* why credentials and real external environments are painful

A strong demo is a coding agent building and testing a Slack bot without a Slack workspace or token.

Stripe

Demonstrates:

* stateful behavior
* complex service logic
* lifecycle
* virtual time

A strong demo is advancing the clock by 30 days and testing subscription renewal behavior locally.

Snapshots, forks, deterministic RNG, MCP generation and cloud environments can come later.

⸻

Launch thesis

The best demo should not focus on framework internals.

It should show the consequence of the architecture.

For example:

"Build a Slack bot that replies 'pong' to 'ping'."

A coding agent then:

1. discovers localhost2137
2. creates local Slack users/channels
3. writes the bot
4. emits a fake Slack message
5. inspects what the bot sent
6. finds problems
7. edits the code
8. repeats

All without:

* a Slack account
* credentials
* OAuth
* manual event triggering
* developer intervention

The immediate alpha audience can be a small technical community where feedback is easy to obtain.

The strongest early signal is not stars.

It is whether people:

* use an emulator for a real project
* let an agent use it autonomously
* request additional services
* write third-party plugins

⸻

Summary

localhost2137 is a local runtime and plugin ecosystem for executable, stateful emulators of external developer services.

Its defining architecture is:

Hono                 → public emulated APIs
Zod                   → config and operation schemas
npm packages          → plugins
plugin-owned storage  → arbitrary state implementation
Operations            → control plane
localhost CLI         → generated operation adapter
TypeScript API        → same operations in tests
virtual clock         → controllable time
instances             → isolated worlds
snapshots/forks       → future reproducibility and parallelism

Its strongest reason to exist is the shift toward coding agents.

Coding agents are increasingly able to implement software autonomously, but external APIs remain one of the places where they regularly need human credentials, permissions and manual setup.

localhost2137 turns those external dependencies into local worlds that agents and developers can create, manipulate, break, reset and test without asking anyone for access.

The long-term opportunity is not merely to provide fake versions of popular APIs.

It is to establish a common runtime and plugin contract for service emulation.
