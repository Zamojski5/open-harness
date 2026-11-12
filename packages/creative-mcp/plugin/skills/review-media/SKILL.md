---
name: review-media
description: How to read media_review results and fix each flag (loudness and true peak, silence, black or frozen frames, flashing, letterboxing, resolution/aspect/fps, first-frame jumps, upscaled sources, safe areas, still-image exposure), plus media_flicker (1-2 frame glitches) and loop_check (seamless loops). Use after any render or export, before delivering a video, audio file or image, or when a user reports a playback/quality problem.
---

# Review media

`media_review {path, platform?, expected_duration?}` is the deterministic gate before delivery. It returns flags sorted by severity with timestamps, a suggested fix, and a contact sheet of the flagged moments (look at it — it tells you whether a flag is real).

- **error**: fix before delivering. No exceptions unless the user explicitly asked for it.
- **warn**: fix, or keep it on purpose and say why in your hand-off.
- **info**: note it; usually intended (fades, head/tail silence, hard cuts).

Always pass `platform` when you know the destination, and `expected_duration` when the brief set one. Re-run after fixing until no errors remain.

## Fixes by flag

### Loudness / true peak

Targets: web & social **-14 LUFS**, podcasts/voice **-16 LUFS**, broadcast **-23 LUFS**; true peak **≤ -1 dBTP**.

- Off target: two-pass loudnorm. Pass 1 measures, pass 2 applies the measured values:
  ```
  ffmpeg -i in.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -
  ffmpeg -i in.mp4 -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true -ar 48000 -c:a aac -b:a 192k out.mp4
  ```
- True peak > -1 only (loudness fine): prefer loudnorm with `TP=-1.5` (it measures true peak). `alimiter` works on sample peaks, so after AAC/MP3 encoding inter-sample overs can still exceed 0 dBTP (tested: a hard-limited signal came back at +4 dBTP). If you use it, limit lower (`alimiter=limit=0.7:level=false`, about -3 dBFS) and re-run media_review.
- Peak ≥ 0 = audible clipping already baked in if the source clipped: lower gain **before** the stage that clipped (voice gen, music mix), don't just limit the result.
- Voice buried under music: duck music 10-15 dB under speech (`sidechaincompress`) or lower the bed to about -26 LUFS beneath voice at -16.

### Silent gaps / completely silent track

- Mid-video gap: extend the music bed, add room tone/ambience, or tighten the edit.
- Head/tail silence ≥ 1 s: trim, or start the sound with the first frame.
- Whole track silent: wrong stream mapped (`-map 0:v -map 1:a`), muted generation, or `anullsrc` placeholder left in. Check with `media_inspect`.

### Black frames

- Mid-video black ≥ 0.1 s: a missing clip, a render that failed for some frames, or a concat gap. Find the source at that timestamp; re-render or close the gap.
- Head/tail black: fine for a fade-in/out ≤ 1 s; trim if longer.
- Dips to black between scenes: keep them ≤ 0.5 s unless the edit language calls for it.

### Frozen picture

Real problems: render stalled, duplicated frames from a wrong fps conversion, a still image stretched over a long shot. Fixes: re-render the range; use `-fps_mode cfr` with the right `-r`; give stills slow motion (Ken Burns: `zoompan=z='min(zoom+0.0008,1.12)':d=<frames>:s=1920x1080`). Intended holds (logo end card, title card) are fine — say so.

### Rapid flashing (error)

More than 3 flashes per second can trigger seizures. Slow strobes to ≤ 3/s, reduce the light/dark difference (e.g. flash to 60% grey, not white), shrink the flashing area to under a quarter of the frame, or replace with a dissolve/glow pulse.

### Brightness jump at cut (info)

Fine for intentional flash cuts. Otherwise match exposure between shots (`eq=brightness=`/`curves`) or use a 4-8 frame dissolve.

### Letterbox / pillarbox

- Unintended bars: the source aspect didn't match the canvas. Scale to fill and crop (`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`) and reposition the subject, or rebuild the layout for the target aspect.
- For vertical from horizontal footage, never just pad: crop around the subject, or blurred-background fill only as a last resort.
- Dark scenes can fool the detector: confirm on the contact sheet.

### Resolution / aspect / fps / format

- Aspect mismatch for a platform: reframe for the platform; don't stretch.
- Below target: re-render at target; upscale (AI or `scale=...:flags=lanczos`) only if re-rendering is impossible.
- VFR (screen recordings, phone footage): `-fps_mode cfr -r 30` before editing.
- H.264/HEVC not yuv420p, or odd dimensions: add `-pix_fmt yuv420p` and even sizes (`scale=trunc(iw/2)*2:trunc(ih/2)*2`).
- Duration differs from expected: wrong frame range, extra concat item, `-shortest` cutting the video, or audio longer than picture.

### Safe areas (vertical platforms, not auto-checked)

In a 1080x1920 frame, keep text, faces and logos out of the top ~250 px, bottom ~450 px and right ~150 px (captions, buttons, username). Check a frame with this overlay (red = covered by UI, green = safe box):

```
ffmpeg -ss 2 -i final.mp4 -frames:v 1 -vf "scale=1080:1920,drawbox=x=0:y=0:w=iw:h=250:color=red@0.35:t=fill,drawbox=x=0:y=ih-450:w=iw:h=450:color=red@0.35:t=fill,drawbox=x=iw-150:y=250:w=150:h=ih-700:color=red@0.35:t=fill,drawbox=x=60:y=250:w=iw-210:h=ih-700:color=lime@0.9:t=4" takes/safe-check.png
```

For 16:9 YouTube keep text inside the central 90% (title-safe), and keep the bottom-right corner clear in the last 5-20 s if end screens will be added.

### Still images

- Low contrast: add a curve/levels, deepen shadows, add a key light or rim light.
- Too dark / too bright: adjust exposure — unless low-key/high-key is the brief.
- Clipped highlights > 5% or crushed shadows > 10%: usually lost detail (sky, skin, metal). Lower exposure, use AgX/Filmic in Blender, or recover with curves. Flat white/black backgrounds of graphics trip this legitimately — say so and move on.

### First frame differs / stretched

A one-frame jump at the start (common in image-to-video output, or a leftover title frame). Trim it: `-vf trim=start_frame=1,setpts=PTS-STARTPTS`. If the clip must start exactly on that image, re-export the still at the clip's size instead.

### Looks upscaled / soft

"Detail ratio" = share of fine detail above half resolution (natural photos/renders ~0.4+, plain 2x upscales < 0.3). Re-render at delivery size; if impossible, use an AI upscaler rather than `scale`. Smooth CG, shallow DOF or heavy denoise can read as soft: check the contact sheet before acting.

## Glitches: media_flicker

Run `media_flicker {path, sensitivity?}` on every AI-generated clip and every rendered animation (media_review does not see single-frame pops). It flags frames unlike both neighbours while the neighbours match (A-B-A), per grid cell, ignoring steady motion and cuts; the strip shows before / glitch / after with the region boxed.

- `medium` (default) for delivery checks; `high` when hunting subtle texture/shadow popping (expect grain false positives on noisy footage); `low` for gross pops only.
- Isolated glitch: replace the frame (duplicate a neighbour or blend: `minterpolate` across it), cut around it, or regenerate the shot. Render pops: re-render that frame range (persistent data off, more samples, fixed noise seed).
- Flicker span (many glitch frames in a row): temporal denoise, `deflicker=size=5`, or `tmix=frames=3` on that range only.
- An intended flash frame is fine — say so in the hand-off.

## Loops: loop_check

For anything meant to loop (social loops, GIFs, backgrounds, UI animations) run `loop_check {path}`. Pass = `seamless`/`near-seamless`: the seam step looks like any other frame step (SSIM last→first close to first→second).

- `duplicate-frame`: last frame = first → a hold at every loop. Drop the last frame.
- `jump`: trim to the frame most similar to the first, or crossfade the tail into the head (0.5-1 s), or rebuild as a true cycle (Blender: cyclic F-curves, frame_end = period end - 1; noise driven by a looping phase).
- `hitch`: motion stalls/reverses or speeds up at the seam — eased loop ends or a wrong period; use linear interpolation through the loop point, trim to an exact period.
  Re-run until it passes; show the strip in the hand-off for loops.
  Measured reference values (clean seam 0.9753 vs 0.9754 inside step; jump 0.900 vs 0.989; duplicated frame 0.9986 vs 0.9755), GIF frame-rate rules and size budgets: `make-motion-graphics` [loops-and-delivery](../make-motion-graphics/references/loops-and-delivery.md).

## After fixing

Re-run `media_review` on the new take, log it with `takes_log` (note: "fixed: loudness -9 → -14, black gap at 12.4 s"), and keep the old take.
