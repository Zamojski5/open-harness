<div align="center">

# Open Harness

**A creative agent for the desktop. One brief in, campaign work out, each version scored by an independent reviewer call before it counts as done.**

<img src="docs/assets/open-harness-launch.gif" alt="Open Harness launch film: one brief becomes a brand book, a 3D product in Blender, a hero film, key visuals and banners" width="640">

<sub>Concept launch film (2× speed). The brand "oto" is fictional and the app window is a recreation for the edit; the timings in the copy are not measurements.</sub>

[Website](https://open-harness-lime.vercel.app/) · [How the quality loop works](#the-quality-loop) · [Download](#download) · [Status](#status)

</div>

---

## What it is

Open Harness is a harness around Claude Code for creative work: images, video, 3D, motion, audio and the edit that ties them together. It runs on **your own Claude subscription** on your Mac. There is no hosted service, no account and no per-seat fee.

The model does the thinking. The harness gives it the environment for production work and keeps it honest:

- **Tools for the real apps.** A creative MCP server drives Blender (live window or headless renders), AI image, video and audio providers, ffmpeg, Figma files and a job queue. 68 skills describe how to work in specific tools and formats, from After Effects and DaVinci Resolve to Remotion and Blender.
- **A quality goal the agent cannot skip.** The agent sets a bar, and an independent reviewer call scores every version. The turn is held open until the bar is met, the budget runs out or the scores stop improving.
- **Money as a first-class constraint.** Every paid generation is quoted before it runs and capped by the user's own words. Variants are made as cheap drafts, and only the version you keep is finished at full price.
- **Brand on every turn.** The project's brand kit travels with each message, so the tenth request is as on-brand as the first.
- **Proof at the end.** `/case-study` turns a finished thread into a case-study page, PDF and video, with client names redacted when the work is confidential.

## The quality loop

```mermaid
flowchart TD
    A[Brief] --> B["goal_set<br/>objective · user's bar in their words · references<br/>target score (default 8/10) · time and spend cap"]
    B --> C[Build one version<br/>small steps, look after each]
    C --> D["goal_review<br/>separate Claude call, no tools, no chat history<br/>sees only goal + stills of references and work"]
    D -->|score ≥ bar| E[goal_end: met]
    D -->|below bar| F[fix the 3 biggest gaps<br/>one variable per retake]
    F --> C
    D -->|time or spend cap hit| G[goal_end: out_of_budget]
    D -->|scores stop improving| H[goal_end: plateau]
    S[Stop hook] -. holds the turn while the goal is open .-> C
```

How it is enforced, not just suggested:

1. **The reviewer never sees the agent's reasoning.** `goal_review` starts a separate Claude call (same model, no tools, no chat history) that gets only the goal, the user's criteria and stills of the references and of the new version. It returns a 0–10 score, whether the bar is met, up to 8 concrete gaps (biggest first) and up to 4 strengths.
2. **The agent cannot declare victory early.** A Claude Code `Stop` hook blocks the end of the turn while the goal is open. `goal_end` with `met` is accepted only after the latest review cleared the bar. Holds are bounded (2 without a review, 24 in total, 12 reviews), so a stuck agent cannot loop forever.
3. **The agent cannot quit early either.** `plateau` and `out_of_budget` are accepted only when the harness says the scores stalled or a limit was reached. `ended` requires a verbatim quote of the user asking to stop.
4. **The user stays in charge.** An interrupt or `/goal clear` releases the hold immediately; if the user asks to stop, the agent closes the goal as `ended` with their words quoted.
5. **The loop shows in the UI.** The thread's goal line shows the latest score against the bar, the top gaps, the number of reviews and the time used.

The working method sits in the `quality-loop` skill: references and a written brief with a rubric first, cheap previews, one contact sheet per check, fixing only the three biggest gaps per round, judging stochastic outputs on at least two samples, and a take ledger, so every version is a new file and nothing is overwritten.

## Spend control

| Mechanism                             | What it does                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `media_estimate` / `media_quote_plan` | Prices a request or a whole plan per provider route before anything runs.                                                        |
| Budget hook                           | A paid generation is refused unless the spend cap was taken from the user's own words.                                           |
| Drafts → finish                       | 2–4 cheap drafts for subjective choices, then `media_finish_draft` / `media_upscale` only for the keeper.                        |
| Provider routing                      | The same model can run on several providers (fal, Runware, Replicate); the cheapest route that can carry the request is offered. |
| Ledger                                | Each generation is logged with its cost, so the thread knows what it has spent.                                                  |

Worked example, calculated from the providers' published prices rather than measured on an invoice: a 10 s, 1080p Seedance 2.5 shot with 4 versions to choose from costs **$46.56** when every version is rendered at 1080p on fal, and **$10.19** when the harness routes the job to the cheapest provider (Runware), makes 4 drafts and finishes only the chosen one at 1080p. That is 78% less. Drafts alone, staying on fal, would bring it to $20.46; routing does the rest. The fal draft price is our assumption and Runware's finish price is derived from its published token rate (see `packages/creative-mcp/src/media/catalog.ts`).

## Brand and context

- **Brand kit per project** (`brand/`): colours, type, logo, voice. A compact `<oh_brand>` block (max 1500 characters) is added to every turn sent to the model, while the stored message keeps only the user's own words. A brand chip in the composer shows what is active; `brand/ACTIVE` picks a captured brand and `brand/NONE` switches it off.
- **`@` picker** for files, threads, creative apps and connected MCP servers. Apps are inserted as chips, so the agent knows which tool you mean.

## Under the hood

```
apps/server/src/openHerness/      hooks: quality goal (Stop), spend, brand + app context
packages/creative-mcp/            stdio MCP server injected into every Claude session
  src/goal/                       goal_set · goal_review · goal_end
  src/media/                      providers, price catalog, routing, jobs, ledger
  src/blender/                    live bridge + headless render
  src/case/                       /case-study: brief, key moments, PDF, MP4, redaction
  src/figma/                      .fig decoder (local), SVG, REST tools  [experimental]
  plugin/skills/                  68 skills
apps/web/                         UI: composer chips, goal line, generation cards, deliverables
```

After `pnpm install`, the creative MCP server also works with Claude Code in a plain terminal:

```bash
claude mcp add open-harness -- node <repo>/packages/creative-mcp/src/server.ts
```

## Download

Version 0.1.0 is on the [Releases](https://github.com/Zamojski5/open-harness/releases) page: a DMG for Apple Silicon Macs and an AppImage for x64 Linux. You also need [Claude Code](https://claude.com/product/claude-code) installed and logged in (`claude auth login`). Blender and ffmpeg are optional, but most creative skills use them.

- **macOS:** the app is not signed with an Apple Developer ID yet, so macOS blocks the first launch. After the first attempt, open **System Settings → Privacy & Security**, scroll to the message about Open Harness and click **Open Anyway**. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Open Harness.app"` once.
- **Linux:** `chmod +x Open-Harness-*.AppImage` and run it. Some creative tools are macOS-only for now (app detection uses macOS install paths, image OCR uses the macOS Vision framework). The Linux build has not been tested on a real machine yet; please report what breaks.

Open Harness keeps its own data in `~/.open-herness` (the app database under `~/.open-herness/app`). It never reads or changes data from T3 Code, so both apps can be installed side by side.

## Build from source

Requirements: macOS or Linux, Node 26.12.1 (exact version), pnpm 12.14, Claude Code installed and logged in. On Linux also `libsecret-1-dev` and `pkg-config`.

```bash
pnpm install
pnpm dev:desktop
```

Release builds come from the `Release` GitHub workflow: push a tag such as `v0.1.0` and it attaches a Linux AppImage and a macOS DMG to a draft release. Building locally needs Rust as well (`pnpm dist:desktop:dmg:arm64` or `pnpm dist:desktop:linux`, each with `-- --build-version <version>`).

Provider keys (fal, OpenAI, Google, ElevenLabs, Runware, Replicate) are asked for inside the app the first time a tool needs one. They are kept on your machine.

## Contributing

Work happens on branches and pull requests into `main`; see [CONTRIBUTING.md](CONTRIBUTING.md). Rules for coding agents are in [AGENTS.md](AGENTS.md).

## Status

**0.1.0, pre-release, macOS (Apple Silicon) and Linux (x64).** Known gaps:

- Some code identifiers still say "Open Herness"; the product name is Open Harness.
- Figma support has not yet been tested on a real `.fig` file.
- A long reviewer call can still leave a turn hanging, and the spend ledger can under-count multi-image jobs. Both are on the fix list.
- Settings and a few screens inherited from T3 Code still mention T3 Code.

## Built on T3 Code

Open Harness is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc. (MIT), an excellent agent harness control surface. Threads, checkpoints, diffs, the provider adapters and the desktop shell come from upstream; the creative layer above is this fork's work. The original upstream README is kept in [docs/T3CODE-README.md](docs/T3CODE-README.md). License: [MIT](LICENSE).
