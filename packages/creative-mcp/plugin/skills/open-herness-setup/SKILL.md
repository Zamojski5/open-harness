---
name: open-herness-setup
description: Diagnose and fix Open Herness setup - which creative apps and CLIs are installed, which paid generation keys are set (store with media_set_key), spend cap, preferences, house style, project brief, and whether the creative MCP / EffectCraft bridge is running. Use when a tool or key is missing, a generation fails with an auth/billing error, or the user asks "is it set up?" / "what can you use?". Not for routine creative preflight.
---

# Open Herness setup

Answer "is it set up?" with facts, one checklist, and the single next step. Each step has an owner: **agent** (you run it) or **user** (they type a key, click in an app, approve an install). Never claim something works without checking it.

## 1. Read what you already have

The `<open_herness_environment>` block in your instructions is generated at session start and lists:

- installed creative apps (Blender, EffectCraft, Krita, GIMP, Inkscape, Audacity, DaVinci Resolve, Kdenlive, Godot, OBS, GarageBand) and the apps that are _not_ installed;
- command-line tools on PATH (`ffmpeg`, `yt-dlp`, `magick`);
- which paid generation keys are set (fal.ai, OpenAI, Google, ElevenLabs);
- user preferences, house-style rules and the project brief.

It can be stale (the user may have installed something since). Re-check live when it matters:

```bash
ls -d /Applications/*.app /Applications/*/*.app 2>/dev/null | grep -iE 'blender|effectcraft|krita|gimp|inkscape|audacity|resolve|kdenlive|godot|obs|unity|epic|roblox|keynote|powerpoint|libreoffice'
command -v ffmpeg ffprobe yt-dlp magick node uv python3 brew butler 2>/dev/null
```

## 2. Checklist (run top to bottom, stop at the first failing row)

| Fact                        | How to check                                                                                                                                              | If missing                                                               | Owner                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------- |
| Creative MCP server answers | call `blender_status` or `media_models`                                                                                                                   | restart the chat/app; the server is `open-herness-creative`              | user                      |
| Blender reachable           | `blender_status`, then `blender_launch`                                                                                                                   | install offer: `brew install --cask blender` (ask first)                 | user approves, agent runs |
| EffectCraft bridge          | `effectcraft_launch`; the CLI is looked up at `$OH_EFFECTCRAFT_CLI`, `~/.open-herness/bin/effectcraft-cli`, `/opt/homebrew/bin`, `/usr/local/bin`         | without the CLI the `effectcraft` MCP server is not added; tell the user | user                      |
| Paid generation keys        | `media_models` lists configured providers                                                                                                                 | see section 3                                                            | user                      |
| Spend cap                   | env `OH_SPEND_CAP_USD` (USD per calendar day)                                                                                                             | optional; mention it before large paid batches                           | user                      |
| Preferences / house style   | `preferences` and `house_style` tools; files `~/.open-herness/preferences.md`, `~/.open-herness/house-style.md`, `<project>/.open-herness/house-style.md` | nothing to fix; offer to record a rule when the user states one          | agent                     |
| Project brief               | `project_brief get` (a `## Project brief` section in CLAUDE.md or AGENTS.md)                                                                              | agree goal/deliverables with the user, then `project_brief set`          | agent + user              |

## 3. Keys

- Supported providers for `media_set_key`: `fal`, `openai`, `google`, `elevenlabs`. Stored in `~/.open-herness/keys.json` (user-only file). Environment variables also count: `FAL_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`.
- When the user pastes a key, call `media_set_key` once, never echo or quote it back, never write it into a project file, log, commit or take sidecar. Confirm with `media_models` that the provider now shows as configured.
- Before asking for a key, say what it unlocks and what it costs (`media_estimate`), and offer the free local route (Blender render, HTML render, `speak_local`). Ask before asking: "no keys" is a valid setup.
- A key for a service we have no built-in route for (Runway, Higgsfield, a stock site, Roblox Open Cloud, ...) is a **custom connector** job: load `custom-connectors`. Do not try to push it through `media_set_key`.
- Auth failure from a provider: the key is missing, wrong or revoked. Ask for a replacement; never retry with the same key. Billing failure: name which key/plan is empty and offer a cheaper or local route.
- If a key appears in chat by accident (e.g. pasted into a prompt), do not repeat it; suggest the user rotate it.

## 4. Installing apps

Never install silently. Offer one exact command with size/time (e.g. `brew install --cask godot`), wait for a yes, then run it. If Homebrew is missing, point to https://brew.sh. Proprietary apps (Unity Hub, Epic Games Launcher, Roblox Studio, DaVinci Resolve) are manual downloads the user does themselves.

## 5. Report

One short block: what works, what is missing, the next step and whose it is. Example: "Blender 5.0 and ffmpeg ready; no generation keys (local renders only). Next (you): paste a fal.ai key if you want AI video (price per clip from media_estimate)."
