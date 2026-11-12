---
name: make-motion-graphics
description: Make motion graphics end to end - animated titles, kinetic typography and designed captions, logo stings/reveals, lower thirds, animated explainers (narrated or not), charts and diagram animations, overlays, seamless social loops, GIFs, stickers, animated backgrounds, Lottie, and picture cut to a music track. Use when the user asks for an intro, title card, animated text, logo animation, lower third, animated infographic, a looping clip/GIF or a music-synced montage; covers planning, style frames, timing and easing, typography, safe areas, reading time, loop seams, transparent AI inserts and delivery size budgets (built in EffectCraft).
---

# Make motion graphics

Build in EffectCraft (load the `effectcraft` skill for tool usage and tested recipes) unless the user named or saved another motion tool, or the project already uses one — then revise it in its own app. Follow `quality-loop` for references, scoring rounds and the take ledger. Sound: `voiceover-and-sound`; music: `make-music`. Finishing/exports: `edit-video`.

## Routing

- **Other motion tools**: maths, algorithms and science diagrams → `manim`; code-built (React/HTML) motion in `remotion` or `hyperframes` when the user prefers code or the project already uses it; `after-effects` when the user asks for it, hands you an .aep, or wants an AE project as the deliverable.
- **Narrated concept explainers** (how an index speeds up a query, what happens when you pay by card): [references/narrated-explainer.md](references/narrated-explainer.md).
- **Milestone / funding / launch / hiring posts**: `make-announcement-video` (it uses this skill to build).
- **Software demos and product UI on screen**: `make-product-demo`; rebuilding a product's UI as motion: [references/product-ui.md](references/product-ui.md).
- **Picture cut to a supplied song** (lyric video, montage, music promo): [references/music-sync.md](references/music-sync.md).
- **An existing Resolve/Kdenlive edit** is not converted or replaced: render the motion elements with alpha and bring them into that edit (`davinci-resolve`, `kdenlive`). Transcripts, word timing and plain captions are `edit-video`'s job; animated or designed caption treatments using those timings are built here.
- **Brand**: for a named brand or product take logo, colours and type from `./brand/brand.md` (`brand-kit`; capture the site first if missing). If `brand/<name>/motion.json` exists (from `brand_motion`), pace cuts and holds from it — measured shot lengths are observations of the brand's film, not a whitelist. When the brief asks for continuity with approved artwork, build from that artwork.
- **Flashing**: keep strobes and full-frame flashes to at most 3 per second (WCAG); `media_review` flags more.

## 1. Brief (ask only what you cannot infer)

Pin down before building, state your assumptions in one short list:

- **Purpose + platform** → size, fps, duration (table below).
- **Copy**: exact text, language (Polish diacritics → verify the font renders ąćęłńóśźż), hierarchy (headline / sub / CTA).
- **Brand**: colours, fonts, logo file (vector SVG/PNG with alpha). No brand → propose 2 palettes and 1–2 typefaces.
- **Tone**: calm-premium / energetic / playful / technical / cinematic. Tone drives timing (section 4).
- **Deliverables**: MP4 for social, ProRes 4444 / PNG sequence with alpha for overlays, Lottie for web/app, GIF for chat/email.

## 2. Platform specs

| Target                       | Comp size              | fps                        | Length                          | Safe area (keep text inside)                                                              |
| ---------------------------- | ---------------------- | -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| YouTube / web 16:9           | 1920×1080              | 24/25/30 (60 for UI demos) | intro 3–7 s                     | title-safe 90 % (96 px L/R, 54 px T/B)                                                    |
| Instagram/TikTok/Shorts 9:16 | 1080×1920              | 30                         | loop 6–15 s, hook in 1 s        | keep clear: top 250 px, bottom 450 px, right 150 px (UI); overlay check in `review-media` |
| Instagram feed 4:5 / 1:1     | 1080×1350 / 1080×1080  | 30                         | 6–15 s                          | 60 px margins                                                                             |
| LinkedIn / X                 | 1920×1080 or 1080×1080 | 30                         | ≤ 30 s, works muted             | captions burned in                                                                        |
| Broadcast lower third        | 1920×1080              | 25 (EU) / 29.97            | in 0.5 s, hold 4–6 s, out 0.4 s | action-safe 93 %, title-safe 90 %                                                         |
| Overlay for an edit          | match the edit         | match                      | –                               | render with alpha                                                                         |
| Lottie                       | 512×512 / 1080×1080    | 30/60                      | ≤ 5 s loop                      | shapes/text only                                                                          |

Always design social content to read **with sound off** (captions, on-screen text).

## 3. Style frames before animation

1. Collect 4–8 references (`reference_search` → `reference_collect` → `reference_board`), write `references/<board>/brief.md`: palette (hex), type, layout grid, motion words (e.g. "snappy, overshoot, staggered").
2. Build **2 style frames** in EffectCraft — the hero frame (all elements settled) and one in-motion frame. Render with `render_preview` (and `screenshot` in the bridge) and show the user before animating when the job is bigger than a single title.
3. Lock composition: a grid (12 columns or thirds), one focal point, headline at most ~60 % of frame width on 16:9, ~85 % on 9:16.

## 4. Timing and easing rules

- **Durations**: small UI element 0.2–0.35 s; text line in 0.4–0.8 s; logo reveal 1.2–2.5 s; full-screen transition 0.4–0.7 s. Readable-text holds: section 4b.
- **Tone → feel**: premium = long eases (75 % influence), slow drifts (2–5 % scale over the shot), little overshoot; energetic = expo-out snaps (0/90 %), 2–4 frame overlaps, overshoot 5–8 %; playful = bounce/overshoot 10–15 %, squash 5 %.
- **Never linear** except constant motion (spins, scrolls, loops that must tile).
- **Stagger**: 2–4 frames between sibling elements (30 fps); 1–2 frames per character for kinetic type.
- **Overlap actions**: start the next element before the previous lands (offset 20–40 % of its duration). Exits are faster than entries (~70 %).
- **Anticipation and settle** on logo hits: tiny pull-back (2–3 %) before the move, overshoot then settle within 6–10 frames.
- **One hero move per beat**; secondary motion (particles, drift, light sweep) stays at < 30 % of the attention.
- **Motion blur on** for fast moves (comp + layer switch, 180°).
- Sync key hits to the music beat when there is music: beat interval = 60 / BPM s (120 BPM → 0.5 s = 15 frames at 30 fps).

## 4b. On-screen text reading time

Count the time text is **fully readable** (settled, not mid-animation, not under a transition) — the entry and exit animations don't count.

- **Hold ≥ characters ÷ 15 s** (characters incl. spaces) for adult viewers reading their own language; use ÷ 12 for children, second-language audiences, dense numbers or busy backgrounds; ÷ 17 is the fastest acceptable for short familiar phrases.
- **Minimum hold 1.5 s** for any text meant to be read (1.0 s for a single word ≤ 8 characters at headline size); add **+0.5 s** when the viewer must also look at an image or when the text appears together with a cut.
- **Maximum** ~2 lines × 32 characters per card; more → split into two cards or cut copy.
- Examples: "Nowa kolekcja" (13 ch) → 1.5 s; "Darmowa dostawa od 200 zł do końca miesiąca" (43 ch) → 2.9 s → round to 3.0 s.
- Kinetic type (1–4 words per beat) may go faster per phrase only if the full sentence is also on screen at the end or carried by voice.
- Nothing readable within 0.5 s of the end of a loop or video (it will be cut off or restart).
- Safe areas: keep text inside title-safe (16:9: central 90 %; 9:16: clear of the top 250 / bottom 450 / right 150 px) — check with the overlay command in `review-media`.
- Verify: list every text card with its first-fully-readable and last-fully-readable time (`render_frame` at both ends) and compute hold vs. the rule before the final render.

## 5. Typography rules

- Max 2 typefaces; contrast by weight/size rather than more fonts. Bundled **Inter** is a safe sans fallback.
- Size floor: 16:9 1080p body ≥ 42 px, headlines 90–180 px; 9:16 captions ≥ 56 px. Line length ≤ 32 characters for on-screen text.
- Caps titles: tracking +40…+120; lowercase body: 0…+10. Leading 1.1–1.25 × size for multi-line.
- Contrast ≥ 4.5:1 against the background; over footage add a 25–40 % black scrim or soft drop shadow (opacity 60–75, softness 10–16).
- Don't animate every word the same way; headline gets the hero animation, sub-lines a simple fade/slide.
- Avoid widows/orphans; break lines by meaning.
- Check text baselines: EffectCraft text `position` is the baseline (see effectcraft known-issues).

## 6. Build order in EffectCraft

1. `comp.new` from the spec table; background (solid + Gradient Ramp, or a plate).
2. Elements as named layers; group with nulls / precomps; a `CTRL` null with Slider Controls for global timing/intensity.
3. Animate hero → secondary → ambient (expressions: `wiggle`, `loopOut`, `time*`).
5. After every step `render_preview` at 2–3 meaningful times (entry mid-point, settle, exit); fix before continuing.

Formats by job:

- **Title / logo sting**: 3–6 s; build-up (0–60 %), hit (logo lands, flash/glow peak, sound hit), hold ≥ 1.5 s, optional tagline.
- **Lower third**: bar wipes in (0.3 s, expo-out), name 4 frames later, title 4 frames after; hold; reverse out faster. Build as one precomp; text editable; render ProRes 4444 alpha.
- **Kinetic typography**: cut the script into phrases of 1–4 words, one beat each; alternate scale/position/rotation moves; camera moves between phrases (null-parented); keep a consistent baseline grid.
- **Explainer scene**: one idea per scene (5–10 s), icon + label + number; transitions that carry motion direction from scene to scene.
- **Social loop**: see section 7.

## 7. Seamless loops

- The frame **after** the last rendered frame must equal frame 0: key value A at 0 and the same A at the loop length L, then render frames 0 … L×fps − 1 (or `loopOut("cycle")`). Rendering both ends duplicates a frame and the loop stutters.
- Periodic expressions with a period that divides the loop length: `Math.sin(time*2*Math.PI/L)` for loop length L.
- Fractal noise: cycle evolution (`evolutionOptions/cycleEvolution`, keyed 0→360×n over L).
- Particles don't loop cleanly — fade them, or prerender 2× length and crossfade the halves (edit-video).
- Render exactly L seconds (frame count = L × fps, no extra frame).
- Easing at the seam: motion must have the same speed on both sides — a value that eases out to a stop at L must also ease in from a stop at 0; otherwise use linear or cyclic motion through the seam. Camera drifts, grain seeds, wiggle and particle systems are the usual leaks.
- **Measure the seam:** compare SSIM of last→first frame with SSIM of frame 0→1. A clean loop has seam SSIM ≥ adjacent SSIM − 0.02:
  ```
  ffmpeg -sseof -0.1 -i loop.mp4 -frames:v 1 -update 1 last.png; ffmpeg -i loop.mp4 -frames:v 1 f0.png
  ffmpeg -i loop.mp4 -vf "select=eq(n\,1)" -frames:v 1 f1.png
  ffmpeg -i last.png -i f0.png -lavfi ssim -f null -   # seam
  ffmpeg -i f0.png -i f1.png -lavfi ssim -f null -     # normal step
  ```
  (For a loop whose motion varies in speed, compare the seam against the step at the same phase.) Then concatenate the file twice and look at the join with `media_frames`; the frame count must be exactly L × fps (`ffprobe -count_frames`).

`loop_check {path}` runs this seam test for you (on the MP4 master and on the GIF). Encoders, GIF frame rates, size budgets per destination and reference seam numbers: [references/loops-and-delivery.md](references/loops-and-delivery.md). A reveal that replays (e.g. a milestone number) loops by reset: build the reset with the same rules and run the seam check on it too.

## 8. Deliver

- Draft at half resolution → review (`media_frames`, `review-media`) → final full resolution.
- Files: `takes/<name>-v01.mp4` (H.264, 15–20 Mbps for 1080p), alpha masters as ProRes 4444 or PNG sequence, Lottie when requested (read the export warnings), GIF via ffmpeg palette (edit-video).
- Save the `.ecproj` next to the renders. Present: the video, 1 still, what was done, what still differs from the references (honest), and which values are easy to change (copy, colour, timing slider).
