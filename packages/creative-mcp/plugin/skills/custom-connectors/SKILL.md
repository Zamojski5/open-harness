---
name: custom-connectors
description: Create, repair or remove a personal connector to a web service the built-in tools don't cover (Runway, Higgsfield, a stock-media site, Roblox Open Cloud, a client's API) - a small zero-dependency script CLI with keychain-held credentials, a cheap verify check, receipts for paid jobs, and its own skill. Use when the user wants to use their own account/key on a service with no built-in route.
---

# Custom connectors

A connector is a folder of scripts that talks to one service with the user's own account. The service bills the user's account, not ours.

## When not to build one

- The built-in route covers it: `media_generate` (fal.ai, OpenAI, Google, ElevenLabs keys via `media_set_key`).
- Public data with no credential (just fetch it).
- Anything needing the user's browser cookies or password (use the website with the user, `computer-use`).
- The service has an official MCP server the user prefers: suggest adding it as an MCP server instead.
  Honour a tool the user explicitly names (including a vendor CLI they already have installed), even if a built-in route exists.

## Layout

Global (reusable across projects): `~/.open-herness/connectors/<id>/`

```
bin/client.mjs        service CLI with subcommands, --json output
bin/verify.mjs        cheap authenticated read, no paid action
bin/login.mjs         only if an OAuth loopback flow is needed
docs/                 snapshots of the official docs pages used
docs/SOURCES.md       per page: URL, fetch time, sha256
vendor/               only pinned official SDKs/binaries (exact version)
CHANGELOG.md          dated notes of every change
```

The connector's skill goes to `~/.claude/skills/connector-<id>/SKILL.md` (or the project's `.claude/skills/` if it is project-specific) so later sessions find it. Receipts go into the **project**: `./connectors/<id>/receipts.jsonl`.

## Create

1. Read the official docs; snapshot the pages you rely on into `docs/` and record URL, time and sha256 in `docs/SOURCES.md`. Summarise for the user: capabilities, billing unit, rate limits, output limits, credentials needed, and every API host the scripts will call (list them in CHANGELOG).
2. Credentials (see below) - ask for all of them in one go.
3. Write `bin/client.mjs` as plain ESM with no dependencies (Node `fetch`), run with `node`. Validate the response shape you depend on. Subcommands are service-specific (`submit`, `status --job`, `download --job --out`), each printing JSON on stdout.
4. Write `bin/verify.mjs`: one cheap authenticated read (account/me, list models). Run it and show the user the result.
   If an official SDK is unavoidable, pin it into `vendor/` (`npm install --prefix vendor pkg@x.y.z`, `pip install --target vendor pkg==x.y.z`).

## Exit codes (all scripts)

0 success (JSON on stdout) - 64 usage error - 75 transient/rate-limited after bounded backoff - 76 unexpected API shape or unclassified failure - 77 credential rejected (HTTP 401/403).
Retry only safe reads: up to 3 attempts, honour `Retry-After` up to 60 s, otherwise exit 75. Requests time out after ~30 s and refuse redirects for authenticated calls.

## Credentials

- Never ask the user to paste a connector credential into the chat. Ask them to store it themselves in the macOS Keychain from their own terminal (the `-w` at the end makes `security` prompt for the value, so it never appears in history):
  `security add-generic-password -U -s open-herness.connector.<id> -a API_KEY -w`
- Scripts read it at run time (`security find-generic-password -s open-herness.connector.<id> -a API_KEY -w`, via `execFileSync` with an argument array) and keep it in the child process only. Names are uppercase identifiers (`API_KEY`, `CLIENT_SECRET`, `REFRESH_TOKEN`); never use runtime names like `PATH`, `NODE_OPTIONS`.
- Never print, log, write to files, put in URLs, receipts, CHANGELOG or command arguments, or read it into your own shell. Error messages print only the fixed classification, because provider errors can echo secrets.
- OAuth: `bin/login.mjs` runs a loopback flow and writes the minted token to the Keychain itself (`security add-generic-password ... -w <value>` spawned with an argument array is acceptable only inside the script; never echo it).
- A locked or unavailable Keychain must surface as an error; do not fall back to a plaintext file unless the user explicitly chooses that (then a 0600 file under `~/.open-herness/connectors/<id>/`, outside any project).
- If a credential appears in chat anyway: do not repeat or save it, recommend rotating it, and have the user store the new one in the Keychain.

## Paid jobs and receipts

- Before paid work: price with arithmetic, who pays, and get a yes.
- Append to `./connectors/<id>/receipts.jsonl` the moment the service accepts work: request id, provider job id, time, status, estimated cost, output path. Never credentials or signed download URLs.
- Never resubmit an uncertain write (timeout after send) without an idempotency key or checking receipts and the provider's job list first.
- Long jobs: start a bounded background poll (`run_in_background`) of `client.mjs status --job ...` and end the turn; download only to a project path the caller chose (`./takes/...`) and log it with `takes_log`.

## Maintain, repair, remove

- Read the connector's CHANGELOG and `docs/SOURCES.md` first.
- Exit 77: ask for a replacement credential before changing code. Exit 76: describe the mismatch (non-secret), offer to repair, re-snapshot the changed docs. Exit 75: try later.
- No background health polling; status only changes when something runs.
- Removal on request: explain it deletes the Keychain entries (`security delete-generic-password -s open-herness.connector.<id> -a <NAME>`) and moves the folder and skill to the Trash; then do it. Never recreate credentials from chat history.
