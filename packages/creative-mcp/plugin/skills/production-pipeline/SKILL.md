---
name: production-pipeline
description: Run an ambitious creative job as a small studio: you direct, creative-builder subagents build each element, an independent creative-auditor checks it until it passes, then integration and final audits.
---

# Production pipeline: director → builder → auditor

One agent doing a whole showcase alone gets sloppy. You are the **director**. You plan, delegate and decide. Builders build, and auditors judge with fresh eyes. Never let the builder grade its own work.

## 0. Setup (director)

1. Read the request. Load `craft`, `quality-loop` and the outcome skill (`make-3d-scene`, `make-trailer`, `make-motion-graphics`…).
2. **Research** (always, and before any building):
   - Run 4-8 specific reference_search queries: the subject, its materials, the lighting mood, the camera language, and real photos for photoreal anchors.
   - Use reference_collect with a note on each image, then reference_board.
   - Write `references/<board>/brief.md`: palette (hex), shapes and proportions with real measurements, lighting (direction, colour temperature, ratio), lens and composition, mood, and what to avoid.
3. Write `production/plan.md`:
   - **Shots**: for each shot, its camera, lens, duration and purpose.
   - **Elements**: build them in dependency order. Typical 3D order:
     1. layout and camera blocking
     2. terrain or set
     3. hero asset
     4. secondary assets and set dressing
     5. vegetation and scatter
     6. materials and look-dev pass
     7. lighting
     8. atmosphere and volumetrics
     9. animation and camera moves
     10. render settings and compositor
   - **Acceptance criteria** for each element. They must be specific and checkable, e.g. "sword blade 90 cm, fuller visible, edge highlight reads in the shot camera", "no texture under 2K on anything within 3 m of the camera", "fog density lets the trees read as 3 depth layers".
   - **Out of scope**: what the job will not include.
4. Show the user the plan in a short message: shots, elements and the look in one paragraph. Then continue without waiting, unless they asked to approve first.

Before planning elements, decide per deliverable whether it needs 3D at all (see choose-tool, "Is 3D actually needed?"). Do not add a Blender element by habit.

## 1. Element loop

For each element, in order, and only one builder in the live Blender scene at a time:

1. Task → `creative-builder` with: the element name, its spec and criteria from the plan, the board name, the files involved, and on later rounds the auditor's DEFECTS and KEEP lists verbatim.
2. Task → `creative-auditor` with the element spec, criteria, board and where to look. **Do not pass the builder's report**: the auditor has to judge the work, not the claims.
3. On PASS, log it with takes_log (add a note and the scores) and move on.
4. On FAIL, send the defects back to a builder.
5. **Maximum 3 rounds per element.** After round 3, pick the best state (takes_compare helps), note what is unresolved in `production/log.md`, and move on.

Work that does not touch the live scene can run in parallel with builders, as separate Task calls in the same message:

- asset downloads;
- sound design;
- EffectCraft title comps;
- research for later shots.

Keep `production/log.md` updated: element, round, verdict, scores and the main defects. It is the job's memory if the context gets long.

## 2. Integration audit

When all elements pass, render a preview of every shot from its camera at 50% resolution with a reduced sample count. Send `creative-auditor` the **whole shot**, judged against the brief. Defects at this stage usually concern the balance between elements: one element too bright or saturated, broken scale relations, or a lack of depth. Route each defect to a builder for the element it belongs to. Allow 2 rounds at most.

## Reference and sameness gates (ads, social, campaigns)

When the job is an ad or campaign and `reference-research` produced a board, compare our piece with the best references at concept, first cut or animatic, and final, as a rule of thumb (skip a gate when it adds nothing and say why in one line): pick the three strongest references, run `media_watch` on ours with the same questions, put contact sheets side by side, and calibrate hook, pacing and legibility. Learn from patterns; never copy shots, text or music. Details in `quality-loop` (references/reference-gates.md).

Before the integration audit of a multi-deliverable campaign, have the auditor put every deliverable side by side and judge sameness in both directions: near-identical pieces (same layout, image, colour pairing or headline everywhere) unless the strategy asked for that, and off-brand drift. Brand constants are checked strictly; variables are judged for intent and range. Route concrete fixes to the builders.

## 3. Final

1. Final renders, using the settings in references/photoreal.md. For animations, render a short test range first, check the time per frame, and tell the user the estimated total time before starting a long render.
2. Edit and sound (`make-trailer`, `edit-video`, `voiceover-and-sound`), then run media_review and fix every error flag.
3. Final audit by `creative-auditor` on the delivered file.
4. Present it (`present-results`): the file, a contact sheet, an honest list of what still differs from the references, and options for the next step.

## Rules

- The auditor's FAIL is binding unless the user overrides it.
- If an element fails twice for the same reason, change approach instead of tweaking. Use a real asset instead of modelling, another technique, or simplify the shot so it hides the weakness.
- Budget: tell the user when a step will take long (renders, many rounds). Paid generations follow `choose-media-model` → paid-generation: quote each batch, builders make drafts for variants, and only the auditor-passed take is finished or upscaled.
- Save the .blend or .ecproj after every passed element, and never overwrite takes.

## Running on Codex

- Sub-agents: use your sub-agent tool (spawn_agent / multi-agent) instead of Task. Give each builder sub-agent the `creative-builder` skill and its element spec; give each auditor sub-agent the `creative-auditor` skill. The auditor must never receive the builder's report.
- Only one builder may drive the live Blender scene at a time. Work that does not touch the live scene runs in parallel sub-agents: asset downloads, AI generations, sound design, EffectCraft comps, and building separate elements in their own .blend files with `blender_script` (headless), which the director then links/appends into the main scene.
- Tool names on Codex have no `mcp__…__` prefix: call `blender_screenshot`, `reference_compare`, `media_review` and so on directly.
