---
name: edit-video
description: Find, cut and finish local footage with ffmpeg — pick lines and cut points from transcripts and frames, word-level speech edits, trim, join, crossfade, speed up/slow down, subtitles or burned-in captions, reframe/export for YouTube, Reels/TikTok/Shorts or square posts, loudness, GIFs, and review. Use whenever the user wants to cut, assemble, caption, convert or deliver a video (interviews, talking recordings, Blender/EffectCraft renders, AI-generated clips).
---

# Edit video with ffmpeg

Tools: creative MCP `media_inspect` (ffprobe JSON), `media_frames` (contact sheet image), `media_review` (QA gate), `ffmpeg` (args array, cwd = project), plus Bash for anything multi-step (scripts, loops, ffprobe one-liners). Word timings: `../voiceover-and-sound/scripts/word_times.py`.

## Route

- **Editor.** Cut here with ffmpeg unless the user names an editor, the project already lives in one, or they want an editable project file: then that editor's skill: `kdenlive` (MLT XML), `davinci-resolve`, `premiere-pro`, `final-cut-pro` (cut here, hand over FCPXML), `descript` or `capcut` hand-offs. If the named editor is unavailable, say which step is blocked and ask before cutting here instead. One recording turned into a captioned social clip stays in ffmpeg unless an app or an editable timeline was requested.
- **This machine's ffmpeg** has `libx264`, `h264_videotoolbox`, `prores_ks` and `libvpx-vp9`, but no `subtitles`/`ass`/`drawtext` filters and no animated-WebP encoder. Re-check with `ffmpeg -hide_banner -encoders` / `-filters` on another machine.
- **Audio-only voice recordings** (clean, repair, level, join, comp takes): `voiceover-and-sound` → "Finish a recording".
- **Designed/animated captions, titles, lower thirds and overlays**: `make-motion-graphics` (EffectCraft), composited here.
- **Checking a render** the user asks about: `media_review FILE` first (with `platform` when known), then ffprobe/ffmpeg only for extra measurements; `media_flicker` for 1–2-frame pops.
- **Brand.** If `./brand/brand.md` exists, read it (see `brand-kit`) first; titles, captions, cards and graphics take its colours, fonts and logos.

**Short social pieces, viral clips and ads must grab attention within 1–3 s**; narrative or slow-burn work can build. **Talking-head videos for social are captioned in the picture by default** — big enough to read on a phone — unless the user opts out or the format is wrong for it.

## Choose lines, takes and cut points

Reuse existing transcripts and analysis; fill gaps only for the files the edit needs. All of this runs locally — nothing is uploaded.

- **Dialogue:** `python3 ../voiceover-and-sound/scripts/word_times.py FILE --lang pl|en` writes word timings (`<file>.words.json`, no speaker labels). Read words and times before choosing lines or trimming speech. Wrong language or words → rerun with the correct `--lang` / a larger `--model`. For sung vocals expect misses; check against the lyrics.
- **Picture and sound:** `media_review FILE` measures loudness, silence, black and frozen spans and returns stills of flagged moments.
- **Moments the user timestamps:** treat their times as correct (1:05.2 = 65.2 s). `media_frames` only samples evenly, so pull frames around each boundary with ffmpeg — e.g. 13 frames ±1.5 s every 0.25 s — tile them into one labelled sheet, read it once, and set in/out from it ([references/speech-edits.md](references/speech-edits.md#frames-around-a-timestamp)). Sample spread frames only for moments the user did not locate. Crop to read small screen text. Checks like a private label that must be masked come from the same sheet.
- Word-level cuts, replacement lines, ducking and caption timing from the transcript: [references/speech-edits.md](references/speech-edits.md). Highlight/selects cut from one interview: join the chosen stretches in order in one recipe, then render once.

## Declarative assemble, finalize, long jobs

- **Multi-clip edit:** write a recipe and call `plan_validate` (refuses impossible ranges, missing files, bad size/fps, transitions longer than their clips, J/L cuts outside the timeline; each error has a fix) then `media_assemble`. It snaps everything to the frame grid, overlaps transitions (`dissolve`, `fade`), builds J/L cuts (`audio_lead`/`audio_trail`: clip audio before/after its picture), ducks music under voice (`duck {amount_db}`), applies `loudness_target` and a 0.95 limiter, and writes `<out>.edit.json` for `media_review`. No text/logo overlays (no drawtext here). Use raw `ffmpeg` only for what the recipe cannot say.
- **Frame folder from Blender:** `render_finalize {frames_dir, fps, intent: edit|deliver|draft}` encodes, verifies count/size/duration and decodes every frame, writes `<video>.blender.json`; pass `delete_frames:true` only after you have looked at the result. A missing frame fails it (frames kept).
- **Anything over a minute** (final encodes, long renders, downloads): `jobs_run {title, argv}` returns at once and survives interruption; check with `jobs_local_status` / `jobs_local_wait`. `jobs_watch {command, until[], fail[]}` waits on another service. Never poll in a foreground loop.

## Ground rules

1. **Inspect before editing.** `media_inspect` every input: duration, codec, WxH, SAR, fps (`r_frame_rate`), pix_fmt, audio rate/channels. Decisions below depend on whether these match.
2. **Outputs go to `./takes/`, never overwrite.** The MCP `ffmpeg` tool always passes `-y`, so it will clobber silently. List `./takes` first and use the next free name: `<name>-take-01.mp4`, `-take-02`, ... Intermediates go in `./takes/work/`.
3. **One concern per pass when debugging, one pass for delivery.** Each lossy re-encode costs quality; chain filters into a single `-filter_complex` for the final render and use CRF 16-18 for intermediates.
4. **Long filtergraphs:** write the graph to a file and pass `-/filter_complex path/graph.fg` (works in this ffmpeg 8; `-filter_complex_script` is deprecated). Avoids quoting hell in the args array.
5. **Review every render:** `media_frames` (12-24 frames) and check: no black/frozen frames, captions inside safe area, transitions where intended. `media_inspect` the output: duration, fps, pix_fmt=yuv420p, audio present. Make 2 takes for key creative choices (crop vs blur-fill, caption style) when cheap, and state honestly what still looks off.

## Decision rules

| Task       | Fast path                                                                                        | Exact path                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Trim       | `-ss A -i in -t D -c copy` — only lands on keyframes; start may be early by up to one GOP        | Re-encode: `-ss A -i in -t D -c:v libx264 -crf 18 -c:a aac -b:a 192k` (frame-accurate)           |
| Join       | concat **demuxer** + `-c copy` when codec, WxH, SAR, fps, pix_fmt, audio rate/channels all match | concat **filter** with each input normalised first (scale/pad, setsar=1, fps, format, aresample) |
| Transition | —                                                                                                | `xfade` + `acrossfade` (always re-encodes)                                                       |
| Speed      | `setpts=PTS/k` + `atempo=k` (chain atempo for k outside 0.5-2)                                   | ramps: split into segments, change each, concat                                                  |

Check keyframes: `ffprobe -v error -select_streams v -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 in.mp4`. Measured here: GOP 2 s, `-ss 2.5 -t 3 -c copy` produced 3.57 s starting from the 2.0 s keyframe; the re-encode gave exactly 3.000 s.

**xfade offset math:** offset = (sum of durations of clips so far) − (number of transitions so far × fade). Two clips 10 s + 6 s, 1 s fade → offset 9, output 15 s. Three clips 10/6/10 → offsets 9 and 14, output 24 s. Both inputs to xfade must share WxH, fps, pix_fmt and timebase — normalise first.

**`-t` placement:** put `-t` _before_ `-i` (limits input) when the filter stretches time; after `-i` it limits the output.

Recipes with exact commands: [references/cut-join-speed.md](references/cut-join-speed.md).

## Subtitles and captions

- Soft subs (toggleable): MP4 `-c:s mov_text`, MKV `-c:s srt`. Set `-metadata:s:s:0 language=pol|eng`.
- Burn-in: first run `ffmpeg -hide_banner -filters | grep -wE 'subtitles|ass|drawtext'`. **This machine's ffmpeg 8.0.1 has none of them** (no libass/freetype). Fallback that works everywhere: `scripts/caption_png.py` renders each SRT cue to a transparent full-frame PNG with Pillow and writes an overlay graph using `enable='between(t,start,end)'`. Or build animated captions as text layers in EffectCraft and composite its render.
- SRT authoring, styling and line-length rules: [references/subtitles.md](references/subtitles.md).

## Loudness

Two-pass `loudnorm`, then verify with `ebur128`. Targets: **−14 LUFS / −1 dBTP** for social video and music, **−16 LUFS / −1.5 dBTP** for voice/podcast/explainers. Use `scripts/loudnorm2pass.sh IN OUT [LUFS] [dBTP] [LRA]` (Bash); it copies video, forces 48 kHz, refuses to overwrite and prints PASS/WARN. Exit code 3 = missed target — correct with a gain pass as it instructs. Details and the manual commands: [references/loudness.md](references/loudness.md).

## Delivery

Default delivery encode: `-c:v libx264 -profile:v high -preset slow -crf 20 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000 -movflags +faststart`.

| Target                       | Size                     | Notes                                                                 |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------- |
| YouTube / web 16:9           | 1920x1080 (or 3840x2160) | 30 or 60 fps; keep source fps if it is 24/25                          |
| Reels / TikTok / Shorts 9:16 | 1080x1920                | keep text/faces out of top ~14% and bottom ~20%, and ~6% side margins |
| Square / feed 1:1            | 1080x1080                | 4:5 (1080x1350) gets more feed space on Instagram                     |

Reframing choice: **crop** when the subject is central and fills the frame; **blur-fill** (scaled blurred copy behind the fitted picture) when the whole frame matters (text, UI, wide shots); **pad** with solid colour only for brand layouts. Commands, bitrate caps, GIF (palettegen/paletteuse) and review sheets: [references/export-gif-review.md](references/export-gif-review.md).

## Pitfalls

- Always end video chains with `format=yuv420p` (or `-pix_fmt yuv420p`); yuv444/10-bit won't play on many phones.
- `setsar=1` after any scale/pad, or players stretch the picture and concat/xfade refuse to link.
- Variable-frame-rate phone footage: add `fps=30` (or the target) before xfade/concat.
- Mono + stereo or 44.1 + 48 kHz inputs break the concat filter: `aresample=48000,aformat=channel_layouts=stereo` every audio input. Inputs without audio: generate silence with `-f lavfi -i anullsrc=r=48000:cl=stereo` and `-shortest`/`atrim`.
- `atempo` is limited to 0.5–2.0 per instance — chain (`atempo=0.5,atempo=0.5` = 0.25x).
- Burned captions on 9:16: font ≥ 70 px at 1080 width; the script defaults to 7% of width for portrait.
