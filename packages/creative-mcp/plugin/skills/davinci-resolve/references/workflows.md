# Resolve workflows (Studio scripting unless noted)

## House style capture

Use the `house-style` skill (house_style tool). When the user corrects an edit decision (shot choice, hold length, cut point), fix it **and** write the rule (instruction + why + trap) so the note is not needed twice.

## Rough cut / assembly (many clips → one timeline)

Deliverable is a gapless **timeline**, not a video. No titles, captions, transitions, effects, music or grading unless asked (that work gets thrown away).

1. `ffprobe` every clip: `r_frame_rate`, `avg_frame_rate`, rotation side data.
2. Episodes of one series share a project (new timeline per episode); create a project only for a new series.
3. New project: set `timelineFrameRate` before any timeline; ask the user to set playback frame rate (traps).
4. Create a bin per episode → set current folder → import.
5. Find shots with contact sheets (`media_frames`) rather than single frames; for long takes ask for shorter per-subject clips if possible. Pre-culled footage: trust the cull, sample less.
6. Build clip infos in seconds, convert once: `start_f = round(start*fps)`, `end_f = start_f + round(dur*fps)` (exclusive), `record += dur_f`. Append in one call; name the timeline after the episode.
7. Verify zero gaps/overlaps, total duration vs target, a few frames. A preview MP4 is only a preview — say so.

## Tighten one long recording (remove dead air)

Deliverable is a **variant** timeline; the original stays untouched. Plan → review → confirm.

1. Transcribe (local whisper; run long jobs in the background — roughly 4–7× realtime).
2. Detect pauses from the clip's own level distribution, not a fixed −30 dB (quiet location sound vs noisy room). If speech and room aren't separable, keep the clip whole and say why.
3. Propose keep-ranges (source frames, end-exclusive) with guard frames around words; default generous. Offer timeline **markers** on proposed cuts if the user wants to review first.
4. Show the editor: lift count, seconds removed, the largest lifts (anything > ~15 s may be silent on-screen demo, not dead air).
5. Assemble the variant: record positions = cumulative sum of keep durations; mirror audio (video+audio item counts ≈ 2× keep ranges; if equal to the video count, the variant is silent). Place one range first, read it back, then batch.
6. Stacked camera + screen tracks: only the analysed layer is rebuilt; recompute the other with a constant offset verified by audio cross-correlation (< 50 ms residual), video-only.
7. Hand over with known limits: fillers mid-phrase, real retakes and re-reads whisper merged into one word are not caught by silence detection.

## Colour

Start from the real colour pipeline (generated display-ready images need no camera-log transform). Match neighbouring shots first (exposure, neutrals, skin or product colour), and only then build the look. Same frames before/after; keep the prior grade recoverable (new local version or a saved still). Damage check on a rendered frame: flat, milky, clipped, banding, noise — reject your own grade if it fails.

## Audio

Dialogue, music and effects on separate tracks; keep word endings and room-tone continuity. Per-parameter Fairlight automation, bus routing and plugins are not scriptable; only whole-mix Fairlight presets (20.2.2+). The AI audio assistant is not scriptable. If item volume can't be set, render a gain-adjusted copy of the stem and use that instead (source untouched). Measure the final mix: integrated LUFS and true peak against the destination (social ≈ −14 LUFS, ≤ −1 dBTP; EBU R128 −23; ATSC −24).

## Conform / interchange

Inspect structure (gaps, source ranges, offline media) before touching. XML import via API can come in offline; relink by exact path only with approved paths. DRT/DRP for Resolve-to-Resolve. AAF is not supported by script-side parsers we have.

## Delivery

1. Representative stills first: title-on and title-off frames, changed cuts, the ending. A black proof is a failed preflight.
2. Load a base preset, set target dir + **new** filename, format/codec (MP4/H.264 for web, MOV/ProRes 422 HQ for masters), keep timeline size and fps.
3. Render, then verify the file: `media_inspect` (video + audio streams, duration, fps), `media_review` (loudness, true peak, black/silence), `media_frames` around changes.
4. Editable handoff: export DRP + copy media + note how to relink; check by importing a copy under a new name, never by replacing the working project.
5. Spec checks: `.mp4` and `.mov` both report container `mov` in ffprobe — tell them apart by codec.
