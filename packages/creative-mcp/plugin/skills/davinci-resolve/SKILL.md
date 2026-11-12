---
name: davinci-resolve
description: Work in DaVinci Resolve (Free or Studio) — hand over an editable cut, script Studio through its Python API (projects, media pool, timelines, markers, titles, CDL/LUT grades, Fusion comps, renders), check renders. Use when the user edits, grades, conforms or delivers in Resolve, or wants a Resolve timeline rather than a finished file.
---

# DaVinci Resolve

Status: **untested here** (Resolve not installed on the dev machine). Resolve is proprietary freeware (Studio is paid) — say so when recommending it.

## 1. Settle the edition first

The automation route depends entirely on it.

- Detect: `ls -d /Applications/DaVinci\ Resolve*/ 2>/dev/null`; `defaults read "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Info.plist" CFBundleShortVersionString`. The app/folder name usually says "Studio" for the paid build.
- If Resolve is running, the Studio connection test (below) settles it. If still unclear, **ask once**: "Free or Studio?" and remember the answer for the project.
- **Mac App Store build** is sandboxed and runs no scripts at all. Tell the user to install from blackmagicdesign.com instead (the free download is enough for the file-handover route).

| Edition | How we drive it                                                                                                                                                                   | Read                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Free    | No external scripting (refused since 19.1; in-app Python removed in 21.1). Hand over an interchange timeline (OTIO / FCPXML / EDL), optionally an in-app Lua script the user runs | [references/free-edition.md](references/free-edition.md)         |

API traps (measured, version-specific) for either route: [references/traps.md](references/traps.md). Rough cut, tighten, colour, audio, conform and delivery workflows: [references/workflows.md](references/workflows.md).

## 2. Ground rules

- **Never quit, kill or restart a running Resolve.** Their open projects live in that process; when it seems frozen, the user decides whether to save and relaunch.
- **Source media is read-only.** No transcoding, proxies, relinking or renaming camera originals unless asked; analysis frames and previews go to `takes/work/`, never beside the source.
- Check the actual timeline bounds and rates before placing anything: source and timeline fps can differ and timelines often start at `01:00:00:00` (frame 86400 at 24 fps).
- Changing one title or shot: revise it on a duplicated/variant timeline and keep the surrounding edit. Do not rebuild a finished timeline.
- Choosing takes, lines or cut points: inspect footage first (`media_inspect`, `media_frames`, `media_review`); word timings need a local transcriber (see gaps).
- One agent drives Resolve at a time; scripting calls are synchronous and a modal dialog blocks them.
- **Never improvise UI geography.** When something must be done by hand, name the operation ("set the clip speed with Resolve's retime controls") and say you can't see their screen. Use only UI paths written in these skill files; otherwise point to Blackmagic's manual for their version.
- UI control on Resolve (`computer-use`) is a last resort and unverified on Resolve — say so if the user asks for it.

## 3. Verify like a finisher

- A successful setter or readback is not proof. Proof is a rendered frame or file: `media_inspect` (streams, fps, duration), `media_frames` at changed cuts / title-on / title-off / the end, `media_review` for loudness, black and silent spans.
- Colour or Fusion claims need a rendered frame; CDL values cannot be read back from Resolve.
- Report what you measured, not that it looks/sounds good.

## Limits

- No Resolve bridge of our own: on Free nothing runs inside Resolve unless the user starts a script; on Studio we write and run Python scripts directly (no job receipts, no render recovery helper).
- Option for Studio users who want an MCP: the open-source **davinci-resolve-mcp** project (github.com/samuelgursky/davinci-resolve-mcp; live Python server + offline Node server). Third-party — install only with the user's consent.
- No local speech-to-text tool in our MCP; use `whisper`/`mlx_whisper` if the user installs one.
