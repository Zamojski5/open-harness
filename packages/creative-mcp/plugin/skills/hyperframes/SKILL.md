---
name: hyperframes
description: Make videos from HTML with HeyGen's open-source HyperFrames — compose scenes in index.html, animate with paused GSAP timelines, lint/check, snapshot stills and render MP4/WebM or ProRes 4444 with alpha. Use for code-built motion graphics, titles, overlays and data-driven videos when HTML/CSS is the natural medium.
---

# HyperFrames

Status: **untested here** (not installed; npm `hyperframes` is at 0.8.222 — the command flags below were documented for 0.8.145, so check `npx hyperframes --help` first). Open source (github.com/heygen-com/hyperframes, docs at hyperframes.heygen.com). Uses Node (installed) and fetches a headless Chrome the first time it renders, which can take minutes — get consent before that first install.

## Project layout

- Each piece gets its own folder, `./<piece>/motion/`. A project belongs to exactly one piece; only reopen it to revise that same piece.
- Pin exact versions of `hyperframes` and `gsap` in `package.json`; use the GSAP copy that the starter ships locally, never a CDN. Create the project with the CLI's own scaffolding command (see `--help`) and skim the docs it installs (`compositions.md`, `gsap.md`) the first time.
- The renderer can't reach files outside the project directory. Copy fonts and logos into `assets/` and use relative URLs; a font referenced via `../brand/…` simply fails. Brand values: `brand-kit`.

## Authoring rules

- All motion comes from **GSAP timelines created paused and pushed onto `window.__timelines`** once their DOM and any async loading are done. No `setTimeout`, CSS keyframes or clock-based animation.
- Size and total duration of the root are read from the static markup; script changes to them have no effect. Scenes are windowed with `data-start` / `data-duration`; the end time itself is outside the window, so reach the final pose a little earlier.
- Safe to tween: transforms, opacity, `filter`, `clipPath`, width/height. Lint refuses layout properties such as `left`, `top`, `margin`, `fontSize`, `letterSpacing`; for tracking effects split text into spans and move their `x`.
- Use `fromTo` rather than `from` — when a sub-composition is re-seeked, `from` can pick up the wrong end value. If several `fromTo` calls share a start pose, `immediateRender: false` keeps a later one from overwriting an earlier one.
- Relative position strings need spaces around the operator (`intro - 0.5`). A misspelt label, missing target or circular reference doesn't error — it quietly becomes 0.
- Every timed `<audio>`/`<video>` needs an `id`. Put timing on either the media element or its wrapper, never both, and leave out `crossorigin`. Don't let a video slot run longer than the remaining source, or the last frame freezes.
- Sub-compositions: a `<template>` holds its own styles, markup and scripts; the host element with `data-composition-src` also needs a `data-composition-id` equal to the inner root and timeline ids. The top-level composition is never inside a template.
- Give the page an opaque background for normal videos (crossfades reveal white otherwise); drop it for alpha overlays. Elements that are static on purpose get `data-no-timeline`.
- Over real footage, limit motion design to titles, lower thirds, captions and cards; the footage keeps its own cutting rhythm.

## Check and render

Run inside the project. JSON goes to stdout and progress to stderr — parse stdout only.

```bash
npx hyperframes lint --json                    # errors here skip the browser checks, so fix first
npx hyperframes check --json
npx hyperframes snapshot --at 1 --no-end --describe false   # still frame, no AI description upload
npx hyperframes render --format mp4 --output out/video.mp4  # --quality draft|looks|delivery
npx hyperframes render --format mov --output out/overlay.mov # ProRes 4444 with alpha
```

- Add `--no-best-effort` so absent or slow media fails the render instead of being dropped; `--strict` makes lint errors fatal. For captures use `--skip-vision` to stay local. Leave `clean` alone (it can delete caches of other projects) and skip the cloud, publish and account commands.
- If direct MP4 isn't available on the platform, render WebM and convert with ffmpeg.
- A `sweep_static` finding says sampled positions never changed — investigate seeking or an animation that finished early; don't add motion just to quiet it.

## Reading time

Each piece of text must sit fully inside the frame, unchanged, for no less than `max(1.5 s, (CJK characters / 4.5) + (other characters / 15) + 1.5 s)`. This is stricter than `make-motion-graphics` §4b; use it for HyperFrames pieces. Typewriters and counting numbers restart the clock on every change unless judged on their final text; caption bands follow their cue times instead. Check by snapshotting the first and last moment each text is fully readable.

## Review

`media_inspect` and `media_frames` on the output; inspect every cut and transition at full frame rate (method in `remotion` → Review); `media_review` for loudness and black frames (flags explained in `review-media`). Licences and credits: `craft` rights-and-sources.

## Limits

No managed wrapper: we run plain `npx`, check version pins ourselves, and have no automated reading-time checker or generated brand motion/font helpers.
