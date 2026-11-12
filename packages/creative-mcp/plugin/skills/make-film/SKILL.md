---
name: make-film
description: Staged production for anything with a story or more than one shot - short film, narrative ad, music video, animated story, multi-shot AI video, explainer with characters. Runs treatment → breakdown → shot list → look-dev and previs → generation → edit as versioned markdown stages in ./film/<project>/ with lock/stale tracking, user approval gates, CUT/CONTINUE join grammar between shots and a story check. Use when the user asks for a film, story, narrative video, scene, episode, or several connected shots.
---

# Make a film

A film fails in the plan, not in the render. Work in stages; each stage is a file the user can read, edit and lock. Downstream stages are built **from** locked upstream versions, so a change upstream visibly invalidates what depends on it.

Tools per shot: Blender (`blender`, `make-3d-scene`) for 3D shots, `media_generate` (`make-ai-video`, `make-image`) for AI shots, EffectCraft (`effectcraft`, `make-motion-graphics`) for titles, compositing and finishing, ffmpeg (`edit-video`) for assembly, `voiceover-and-sound` for audio. Quality: `quality-loop` on every element; for ambitious jobs run the generation stage as `production-pipeline` (director → builder → auditor). Looks: `video-styles`. Trailers specifically: `make-trailer` for rhythm rules.

## Stage files

`./film/<project>/` holds one markdown file per stage. Templates and front matter: [references/stage-templates.md](references/stage-templates.md).

| File | Contains | Locks when |
|---|---|---|
| `01-treatment.md` | logline, premise, tone, audience, length, format, beat outline | story check passes and user approves |
| `02-breakdown.md` | characters, locations, props, wardrobe, each as a cast card (description, reference images, invariant traits) | every element in the treatment has a card |
| `03-shot-list.md` | scenes → shots: id, duration, framing, lens, move, action, dialogue/VO, source tool, join to next (CUT/CONTINUE + reason) | timings sum to target length ±10 % and every boundary is marked |
| `04-look-dev.md` | chosen look (from `video-styles`), hero frames per scene/location, palette, motion test, previs (animatic) | hero frames + 2–4 s motion test approved |
| `05-generation.md` | per shot: takes, settings, the one variable changed, scores, artifacts, pick | every shot has a picked take that passes |
| `06-edit.md` | timeline (shot, in/out, transition), sound plan, titles, delivery spec, review results | `media_review` clean and user approves |

Front matter on every stage:

```yaml
---
stage: 03-shot-list
status: draft        # draft | locked | stale
version: 2
built_from: [01-treatment@3, 02-breakdown@1]
user_edited: [shots.S04.action, shots.S07.duration]
---
```

### State rules (follow exactly)

1. **Create** a stage as `draft`, `version: 1`, `built_from` = the current locked versions it used.
2. **Lock** = set `status: locked`. Only locked stages may feed the next stage.
3. **Edit a locked stage** (user asks for a change, or a later stage reveals a problem): set it to `draft`, bump `version` on re-lock, then mark **every later stage** whose `built_from` references an older version as `stale`. Tell the user which stages went stale.
4. **Rebuild a stale stage** from its new inputs; update `built_from`; keep everything listed in `user_edited` unless it now contradicts the upstream change — then ask.
5. **Record user edits.** When the user edits a stage file by hand (diff it against your last write) or dictates a change, add the field path to `user_edited`. Never silently overwrite those fields.
6. Never delete older versions of generated media; `05-generation.md` keeps the full take history.

## Pace (ask once at the start, default B)

- **A. Review every stage** — stop after each stage for approval. Best for first projects and long films.
- **B. One approval** — draft 01–04 in one run, present them together (logline, beat list, shot table, hero frames), get one approval, then generate and edit without stopping except for cost confirmations.
- **C. Autonomous** — run everything; still respect paid-generation cost confirmation (`make-ai-video` §0) and present at the end with the stage files.

Approval question (always these three options, in the user's language):

> **Approve** — lock and continue · **Change X** — tell me what to change (I'll edit only that) · **Redo** — rebuild this stage from scratch with a new direction

## Workflow

1. **Treatment.** Write logline + beats; run the story check ([references/story-check.md](references/story-check.md)). Rubric score < 3 on any axis blocks the lock; max 3 revision rounds, then present the remaining weakness to the user.
2. **Breakdown.** Extract every character, location and prop. For each: 2–4 sentence description with invariant traits (age, build, hair, costume colours in hex, distinguishing marks), and reference images (generate one neutral portrait/turnaround per character, one establishing still per location). These cards are reused verbatim in every prompt — copy the invariant line, don't re-describe.
3. **Shot list.** Break scenes into shots; assign each a source tool. Mark every boundary between consecutive shots CUT or CONTINUE ([references/join-grammar.md](references/join-grammar.md)). Shot length follows the action, never a model's clip limit.
4. **Look-dev + previs.** Pick a look from `video-styles`; lock **one hero frame** per scene first, then a 2–4 s motion test of the hardest shot. Build a previs/animatic: keyframe stills (or Blender grey-box renders) held for each shot's duration, with temp VO/music, concatenated with ffmpeg. Watch timing on the animatic before spending on generation.
5. **Generation.** Per shot, follow `make-ai-video` / `blender` with `quality-loop` retake discipline; log each take in `05-generation.md` and `takes_log`. Generate CONTINUE runs in order (each depends on the previous clip).
6. **Edit.** Assemble per `06-edit.md`; sound per `voiceover-and-sound`; titles in EffectCraft; unifying grade; `media_review`; present with `present-results`.

## Pitfalls

- Starting generation before the shot list is locked — you will pay for shots the story doesn't need.
- Describing a character differently in each prompt — identity drifts. Paste the cast-card line.
- Ending a shot because the model stops at 5/8/10 s. That is a CONTINUE join, not a cut.
- Cutting on "and then" — a cut with no reason feels like a jump; see join grammar.
- Skipping the animatic: pacing problems are cheap on stills and expensive on renders.
