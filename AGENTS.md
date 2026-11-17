# Open Harness

Open Harness is a desktop creative agent: a harness around Claude Code (and Codex) for images, video, 3D, motion, audio and the edit. It runs on the user's own subscription on their Mac. It is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). The chat, threads, checkpoints, provider adapters and desktop shell come from upstream; the creative layer is ours.

This file is for coding agents working on this repository. `CLAUDE.md` imports it.

## Glossary

- **you**: the agent reading this file and changing Open Harness.
- **we, maintainers**: the people building Open Harness.
- **user**: the person who uses Open Harness to direct agents.
- **agent**: the Claude Code or Codex session a user runs inside Open Harness.
- **provider**: the agent runtime the server talks to (Claude, Codex; upstream adapters for others are kept).
- **creative MCP**: `packages/creative-mcp`, the stdio MCP server and skills plugin added to every agent session.
- **project, thread, turn**: a workspace folder, a conversation in it, one user-to-agent cycle.
- **app home**: the base data directory, `~/.open-herness/app` by default (`T3CODE_HOME` or `--home-dir` overrides it). Creative tools keep keys, jobs and the spend ledger in `~/.open-herness`.

## Never do this

1. **Never touch another app's data.** Open Harness must not read, write or import T3 Code's `~/.t3`, its Electron profiles, or the live Open Harness database (`~/.open-herness/app/userdata`). Dev servers use their own home: a worktree's gitignored `.t3`, or an explicit `--home-dir`.
2. **Never kill by pattern.** No `pkill -f`, `pgrep | kill`, or killing a PID found by name. Kill only a PID you started, or quit the app from its own menu.
3. **Never bake in origins.** Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known`.
4. **Never commit personal or client material.** No real client names, footage, keys, emails or local paths. Example data uses fictional brands.

## Dev

- Requirements: macOS, Node 26.12.1, pnpm 12.14, Claude Code installed and logged in.
- `pnpm install`, then `pnpm dev:desktop` for the desktop app or `vp run dev` for server and web.
- A new worktree starts with an empty database. `--seed` (or `T3CODE_DEV_SEED=1`) copies recent data from the app home, read-only.
- Ports come from the worktree path; read the real ones from the `[dev-runner]` line.
- Stop what you started, by the PID you tracked.

## Verifying

- While you iterate: `vp test run <files>`. Before you push: `vp run check:changed`.
- Creative MCP: `cd packages/creative-mcp && vp test run --config ../../vite.config.ts --dir test && node --test src/`.
- Do not run repo-wide checks unless asked. CI owns the full suite.
- Test behavior that can break (orchestration, provider protocol translation, persistence, spend and goal rules, parsing). Skip tests for copy text, trivial logic and static markup.
- Logic bugs get a failing test first, then the fix. Visual bugs get before/after captures.
- In tests, await events, `Deferred`s or the effect worker. Never sleep or poll; lint enforces this.
- Real agent turns and paid generations cost money. Use the `Replay (dev)` provider to watch a turn, and never run a paid generation without the maintainer's approval.

## Building a release

- Releases: push a tag `v<x.y.z>`; the `Release` workflow builds an unsigned Linux AppImage and macOS DMG and attaches them to a draft release. Locally: `pnpm dist:desktop:dmg:arm64` or `pnpm dist:desktop:linux` with `-- --build-version <x.y.z>` (needs Rust). The creative MCP package is staged into `Contents/Resources/packages/creative-mcp` with its production dependencies.
- The app has no update feed unless `T3CODE_DESKTOP_UPDATE_REPOSITORY` is set at build time.

## Pull requests

- Work on a branch, one change per PR into `main`. Never push to `main` directly.
- Conventional commit titles in plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then the fix. UI changes need before/after images.
- Do not commit plans, research notes or scratch files.

## How it works

Clients send typed WebSocket requests. The server turns them into commands; the orchestrator (`apps/server/src/orchestration-v2/Orchestrator.ts`) decides events without I/O; the event sink commits events, projections and outbox effects in one transaction; the effect worker runs the effects. Provider CLIs run as subprocesses behind per-provider adapters. Each turn ends with a checkpoint (a hidden git ref).

Open Harness additions:

- `apps/server/src/openHerness/`: hooks for the quality goal (Stop), spend rules, brand and app context per turn; `creativeMcp.ts` adds the creative MCP server and skills to every session.
- `packages/creative-mcp/`: MCP tools (goal, media providers and pricing, Blender, case study, Figma) and `plugin/skills/`.
- `apps/web/`: composer chips, `@` app picker, goal line, generation cards.

## Where code lives

- `apps/server`: WebSocket, orchestration, providers, checkpointing. Effect-heavy; read `docs/internals/effect-services.md` first.
- `apps/web`: React/Vite UI. `apps/desktop` wraps it in Electron.
- `packages/contracts`: Effect/Schema contracts. `packages/shared`: shared runtime utils, subpath exports.
- `packages/creative-mcp`: the creative layer, plain TypeScript run directly by Node.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Server features are services; transports (RPC handlers, routes, MCP tools) decode input, call one service method and map errors.
- `apps/web/src/components/ui` components own their look: pick a `variant`, do not restyle with `className`.
- Reusable Effect functions use `Effect.fn("Service.operation")`.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment; write one only for a constraint or invariant the code cannot show.
- No continuously repainting animations.
- If a rule here fights the task, say so and get a maintainer's sign-off before breaking it.
