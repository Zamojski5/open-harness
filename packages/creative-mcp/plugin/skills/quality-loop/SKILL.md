---
name: quality-loop
description: The iteration harness for any creative deliverable: references, brief, step-wise builds, scored rounds, retake discipline (drafts for variants, finish only keepers), AI-artifact checks, take ledger and honest hand-off.
---

# Quality loop

Good results come from a short, disciplined loop, not from one long attempt. Run it for every piece of creative work; scale its depth to the request (a quick social still needs 1-2 rounds, a hero video 3-4).

## 0. Before building

1. **Read the house style.** Rules under "House style" in your environment block override defaults. Re-check them before each round.
2. **References.** `reference_search` (3-5 specific queries) → `reference_collect` 5-8 keepers, each with a note on what it contributes → `reference_board`. Skip only for purely technical jobs (transcode, trim).
3. **Brief.** Write `references/<board>/brief.md` (10-20 lines): goal and audience, deliverable spec (size, fps, duration, platform, loudness), palette hex, shapes/proportions, light, composition, motion/pacing, type, mood words, what to avoid, and the **rubric** you will score against (below). If the request is ambiguous on something expensive to redo (aspect, duration, voice language), ask once; otherwise decide and state the assumption.

## 1. Build in small steps

- One logical step per tool call (layout → main subject → materials/colour → light → camera/motion → text → sound).
- Look after every visual step (screenshot / `render_frame` / `media_frames`). Fix obvious problems right away; don't stack five steps on a broken base.
- Save project files as you go (`scenes/`), so any take can be re-rendered.

## 2. Preview, score, fix

1. Render a cheap preview (half resolution, low samples, a few key frames or a 3-5 s excerpt).
2. `reference_compare` against the board; for video also `media_frames`.
3. Score each rubric axis 1-10, one sentence of evidence per score. Be strict: 7 = good enough to ship, 9 = matches the best reference.
4. Pick the **3 biggest gaps** (lowest score × most visible) and fix only those. Fixing everything at once makes it impossible to know what helped.
5. Each round produces a new file in `./takes/` (never overwrite) and a `takes_log add` entry: what changed vs the previous take, and the total/average score.

### Keep each round cheap

- **One contact sheet per check.** A round's checks (key frames, cut points, the last frame) belong on a single tiled image you view once: for hand-picked moments, a small script that grabs those timestamps and tiles them (ffmpeg `select` + `tile`); for evenly spaced samples, `media_frames`. Each tool call makes the model process the full chat history again, so a string of single-still looks, or a follow-up sheet of a render already sheeted, costs more than the one sheet.
- **Correct the render ETA early.** When the first handful of frames of a long render has landed, project the end from their average time per frame × frames remaining. If that differs clearly from the time you quoted, give the user the corrected figure.
- **Audio styling: one change per revision.** When tuning a voice or a mix, change one named setting per revision (see `voiceover-and-sound`).

**Stop when:** every axis ≥ 7 and the average ≥ 7.5; or after **4 rounds** (2 for quick jobs); or when two rounds in a row gain < 0.5. Then move on and say what is left, rather than polishing forever.

### Rubric axes per medium

| Medium                | Axes                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Still image / graphic | composition & focal point, palette fidelity to brief, lighting/contrast, detail & finish (artifacts, edges, text crispness), legibility of copy, match to references   |
| 3D render             | silhouette & proportions, materials, lighting & shadows, camera/lens, render cleanliness (noise, fireflies, clipping), match to references                             |
| Motion graphics       | timing & easing, hierarchy/legibility (on-screen ≥ 1.5 s per short line), consistency of style, transitions, final frame/logo hold, sound sync                         |
| Video edit            | story/hook in the first 2 s, pacing (shot length fits the genre), continuity, colour consistency across shots, audio mix (voice clear over music), captions/safe areas |
| Audio                 | clarity, loudness to target, balance voice/music/SFX, no clicks/clipping, fits the mood                                                                                |

## 3. When to make 2+ takes

Make parallel alternatives (not sequential fixes) when the choice is **subjective and cheap**: colour grade or palette, typeface, music bed, voice, a hero composition. Render them, `takes_compare` side by side, pick with reasons, `takes_log pick`.

Paid AI generations: alternatives are **drafts only** — 2–4 cheap variants (Seedance 2.5 drafts, a Turbo/Flash tier, 0.5–1K stills), then finish or upscale only the one that is kept (`media_finish_draft`, `media_upscale`). Never make 2–4 finished, full-price variants. Do not branch on expensive things (full 3D animation renders, long video renders) — decide on stills first, then render once.

## 3b. Retake discipline (generations and any stochastic render)

Applies whenever an output varies between runs (AI images/video/audio, simulations, seeds) — and to deterministic builds as far as it fits.

1. **Rebuild, don't patch.** After a failed take, rewrite the prompt / setup from `brief.md` and the shot spec, folding in what you learned. Do not append "also…, make sure…, no…" clauses to the old prompt — patched prompts collect contradictions and the model weighs them unpredictably.
2. **One variable per retake.** Change exactly one thing (a prompt clause, seed, keyframe, model, duration, reference image, light) and name it in the log. Two changes at once = you learn nothing.
3. **Judge on ≥ 2 samples.** One generation is noise. Compare a change on at least 2 outputs (same settings, different seeds) before deciding it helped; 3-4 for subtle changes.
4. **Keep the ledger.** Every take gets `takes_log add`: file, the variable changed, scores per axis, artifacts found, verdict (keep / reject + reason). Read the log before each retake so you don't retry a dead end.
5. **Never ship the best of failing takes.** If every take fails a rubric axis (< 7, or any blocker from the artifact checklist), "pick the least bad" is not an option. Change approach — new keyframe, another model, a simpler shot, another tool (Blender/EffectCraft instead of generation), hide the weak part in the edit — or tell the user plainly what fails and offer options.
6. **Cap it.** Decide the retake budget up front (default 3 per shot before rethinking the approach); paid generations count against the cost you announced. Fix a kept take with an edit, extension or insert before paying for a whole re-roll.

Check every generated take against [references/ai-artifacts.md](references/ai-artifacts.md) — a blocker there fails the take regardless of its score.

## 3c. Reference and sameness gates (ads, social, campaigns)

If research produced `references/<board>/patterns.md`, check our work against it at concept, first cut and final. As a rule of thumb compare with the three best references: `media_watch` on ours with the same questions, contact sheets side by side, then calibrate hook, pacing and legibility. For a set of deliverables also check sameness (near-identical pieces, or off-brand drift) with measurements, and fail with concrete fixes. Method, rubric and what counts as a constant versus a variable: [references/reference-gates.md](references/reference-gates.md). Never copy shots, text or music.

## 4. Final render and review

1. Render the final at full spec (resolution, fps, codec `-pix_fmt yuv420p` for H.264, audio AAC 48 kHz).
2. Run `media_review` with `platform` and `expected_duration`. Fix every **error**; fix warnings unless they are intended and you can say why (see the `review-media` skill). Re-run until clean.
3. Look at the final yourself once more (`media_frames` / open the still) — the deterministic check doesn't see taste.

## 5. Present

Follow the `present-results` skill: final file path, a contact sheet or the image, what you did, what still differs from the references, 2-3 next options. Keep all takes.

## Pitfalls

- Scoring yourself generously. If you can't point at the reference that the result matches, it is not a 9.
- Changing several things per round, then not knowing what helped.
- Spending rounds on details before the composition/timing is right. Fix big structure first, finish last.
- Forgetting audio: a silent or clipping video is the most common "finished but broken" deliverable.
- Ignoring house-style rules after a long session: re-read them before the final render.
