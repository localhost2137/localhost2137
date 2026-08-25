#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The full interaction story as a terminal transcript (illustrative).
# This is what "talking to localhost2137" feels like from a shell —
# which is exactly how coding agents talk to it.
# ─────────────────────────────────────────────────────────────────────────────

# ── 1. Boot the world ────────────────────────────────────────────────────────
$ localhost dev

  instance   dev · fresh · empty
  slack      → http://127.0.0.1:2137/dev/slack     ready
  stripe     → http://127.0.0.1:2137/dev/stripe    ready

  Connect your app:
    load .localhost2137/.env   (SLACK_BASE_URL, SLACK_BOT_TOKEN,
                                STRIPE_API_KEY, STRIPE_WEBHOOK_URL, …)

  Control plane: CLI (localhost exec …) or authenticated HTTP under /_/v1

# ── 2. Discover the control surface (no service knowledge hardcoded) ────────
$ localhost exec slack --help

  operations:
    create-user     Create a user in the workspace
    create-channel  Create a channel
    send-message    Send a message as if a user typed it
    list-messages   Inspect messages in a channel
    set-presence    Set a user's presence

$ localhost describe slack --json | jq '.operations | keys'
["createChannel","createUser","listMessages","sendMessage","setPresence"]

$ localhost describe slack --json | jq '.operations.createUser.input'
{"type":"object","properties":{"name":{"type":"string"},"admin":{"type":"boolean","default":false}}}

# Same discovery over plain HTTP (curl-only agents, Playwright, CI).
# Runtime API lives under the reserved /_/ namespace:
$ curl -s localhost:2137/_/v1/instances/dev/services \
    -H "authorization: Bearer $LOCALHOST_CONTROL_TOKEN" | jq -r '.data[]|.name'
slack
stripe

# ── 3. Manipulate the world ──────────────────────────────────────────────────
$ localhost exec slack create-user --name Alice --admin --json
{"id":"U000001","name":"Alice","admin":true}

# Target a non-default instance with --instance (URLs become /t-w1/slack/…):
$ localhost exec slack create-user --instance t-w1 --name Alice --json

# Or over HTTP, instance in the path:
$ curl -s -X POST localhost:2137/_/v1/instances/t-w1/services/slack/operations/createUser \
    -H "authorization: Bearer $LOCALHOST_CONTROL_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"name":"Bob"}' | jq

$ localhost exec slack send-message --channel general --from U000001 --text ping
Created message M000001 in #general

# The app under test just received the Events API payload at its eventsUrl.

# ── 4. Parallel worlds (instances) ───────────────────────────────────────────
# One server owns :2137. Instances are path-scoped worlds materialized from
# the same config template. "dev" is auto-bootstrapped by `localhost dev`;
# extra worlds are explicit:

$ localhost instance create pr-1337
created pr-1337 → http://127.0.0.1:2137/pr-1337/{service}

$ localhost instance create review --seed
created review (seeded) → http://127.0.0.1:2137/review/{service}

$ localhost instance list
NAME      SERVICES             STORAGE   CREATED
dev       slack stripe github    12 MB     2h ago
pr-1337   slack stripe github  0 B       just now
review    slack stripe github  1 MB      just now

$ localhost exec slack send-message --channel general --from U_ALICE \
    --text "deploy looks good" --instance pr-1337
Created message M000001 in #general [pr-1337]

# …or scope a whole shell session instead of repeating the flag:
$ export LOCALHOST_INSTANCE=pr-1337
$ localhost exec slack list-messages --channel general --json

# Unknown instance → helpful failure:
$ localhost exec slack list-messages --channel general --instance nope
error: no instance "nope" (existing: dev, pr-1337, review)
hint:  localhost instance create nope

# Over HTTP the instance is a path segment:
$ curl -s -X POST 'localhost:2137/_/v1/instances/review/services/slack/operations/sendMessage' \
    -H "authorization: Bearer $LOCALHOST_CONTROL_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"channel":"C_GENERAL","from":"U_ALICE","text":"ping"}' | jq

$ localhost instance destroy pr-1337
destroyed pr-1337 (storage freed)

# State persists across server restarts: Ctrl-C on `localhost dev` unmounts
# routes but keeps storage; next boot remounts every instance (plugin `start`
# hooks rerun). The process is disposable, the worlds are not.

# ── 5. Inspect ───────────────────────────────────────────────────────────────
$ localhost exec slack list-messages --channel general --json
[{"id":"M000001","userId":"U000001","text":"ping"},{"id":"M000002","userId":"U000000","text":"pong"}]

$ localhost logs slack --tail 5        # requests hitting the emulated API
$ localhost logs webhooks --tail 5     # deliveries pushed to your app

# ── 6. Time travel ───────────────────────────────────────────────────────────
$ localhost clock status
mode=real now=2026-08-25T14:02:11Z

$ localhost clock advance 30d
now=2026-09-24T14:02:11Z  emitted: stripe.invoice.paid, slack.subscription.renewed*

# ── 7. Seeding & reset (explicit, never automatic) ──────────────────────────
$ localhost seed            # plugin declarative seeds → top-level scenario seed
seeded slack, stripe, then scenario

$ localhost reset           # wipe state → create → start (world is empty)
$ localhost reset --seed    # wipe, then run seeding right after

# ── 8. Machine-readable env export (for sourcing in scripts/CI) ─────────────
$ localhost env --format dotenv >> .env.local

# …or skip the file entirely: run your app with connection env injected
# (env vars only + signal forwarding — not a process supervisor):
$ localhost run -- npm run dev
