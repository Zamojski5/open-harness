---
name: filmcraft
description: Drive FilmCraft (open-source Premiere Pro-class video editor) through its MCP tools or CLI - projects, bins, media import and proxies, sequences, placing/trimming/razor/ripple edits, speed and time remapping, transitions, effects and keyframes, masks with tracking, Lumetri colour grading (basic, creative looks/LUTs, curves, wheels, HSL, scopes, shot match), titles/graphics, captions and transcripts, audio mixer, Essential Sound (loudness, ducking, noise repair), narration (TTS), and export (H.264/HEVC/ProRes/DNxHR/image sequences/audio, presets, queue). Load before any mcp__filmcraft__* call, and whenever a task means cutting, grading, mixing or exporting an editable video timeline in FilmCraft.
---

# FilmCraft

FilmCraft is a timeline video editor. Menus, shortcuts and timeline gestures all map to engine commands (about 700: `timeline.place`, `timeline.razor`, `effects.setParam`, `lumetri.applyPreset`, `file.exportMedia`…). Written against `filmcraft-cli 0.14.0` from its help and command catalogue; **untested here** — confirm with `render_frame` and `sequence_inspect`.

Pick it when the user wants an **editable edit** (a project they can open and keep cutting) or proper grading/mixing on a timeline. Quick one-shot cuts and conversions stay with ffmpeg (`edit-video`); motion graphics belong in EffectCraft.

## Connect

- The `filmcraft` MCP server runs **headless** (`filmcraft-cli mcp`, optionally `--project F.fcproj`). The live-app tools (`ui_*`: click, drag, key, type, elements, screenshot, control) only work when bridged to a running `filmcraft --control PORT` via `mcp --bridge 127.0.0.1:PORT`; headless, use `render_frame` / `render_preview`. The CLI shows no automation-root flags, so pass absolute paths and keep writes inside the project folder yourself.
- To show the user: `command_run file.saveAs {path:"/abs/<project>/filmcraft/<name>-v01.fcproj"}`, then `craft_launch {app:"filmcraft", files:[that path]}`.
- Shell alternative `~/.open-herness/bin/filmcraft-cli [--project P | --demo] [--save | --save-as P] <sub>`: `exec ID key=value…|'{json}'` · `run script.jsonl` (one `{"id","params"}` per line; exports wait for their file unless `"wait": false`) · `commands [filter]` · `describe ID` · `inspect [project|sequence]` · `import FILES` · `export OUT [--preset NAME | --format F] [--range entire|inOut|workArea] [--scale 0.5] [--no-audio] [--allow-offline]` · `export --list-presets` · `render --seconds S --out f.png` · `probe MEDIA`. Every CLI call is a fresh engine: chain with `--project … --save`.

## Tools

`doc_inspect` / `project_inspect` / `sequence_inspect` (ids, clip start/duration in ticks and frames, effects, transitions, markers) · `media_import {paths}` (absolute) · `command_list` → `command_run {id, params}` / `command_batch {steps}` · `render_frame {seconds}` / `render_preview`.

## Rules

1. **Time is in ticks: 254 016 000 000 per second.** Most commands also accept `seconds`, `frame` or `timecode` — prefer those.
2. **Orient first** with `doc_inspect`; act on clip/item ids it returns, never guessed ones.
3. **Sequence settings follow the delivery**: `file.newSequence {name, width, height, fps, sampleRate}` (defaults 1920×1080, 23.976). Don't mix frame rates in one cut; conform with `clip.interpretFootage`.
4. **Look at the cut points and graded frames** with `render_frame`, and read `scopes.read` (waveform, parade, vectorscope) when grading instead of trusting the eye alone.
5. **Offline media renders as placeholders**: an export with missing media exits 1 and lists `offlineMedia`; fix with `media.findMissing` / `media.relink`, don't pass `--allow-offline` for deliverables.
6. **Version everything**: save `.fcproj` takes and write exports to `takes/` with a suffix; never overwrite.

## Workflow

1. Project: `file.newProject` (or open), `file.newBin`, `media_import` / `file.import {paths, bin}` / `file.importImageSequence`; heavy footage → `media.createProxies`.
2. Sequence: `file.newSequence` or `file.newSequenceFromClip`.
3. Assemble: `timeline.place {item | items, track, seconds, insert, sourceIn?, duration?}`; source monitor `source.insert` / `source.overwrite`.
4. Edit: `timeline.razor`, `timeline.trim {clip, edge, mode: regular|ripple, deltaFrames}`, `timeline.roll`/`slip`/`slide`, `timeline.move`, `edit.rippleDelete`, `sequence.closeGap`; speed via `clip.speedDuration {speed, reverse, interpolation}`; `clip.nest`.
5. Transitions & effects: `sequence.applyVideoTransition {clip, effect, frames, edge}`; `effects.list {kind}` → `effects.apply {clips, effect}` → `effects.setParam {clip, effect, param, value, time?}`; keyframes `effects.addKeyframe` / `effects.setInterpolation`; masks `masks.add` + `masks.track`.
6. Colour: `lumetri.applyPreset`, or apply the `lumetri` effect and set params (`exposure`, `contrast`, `temperature`, `look_lut`, `curve_*`, `wheel_*`, `hsl_*`, `vignette_*`); LUTs via `lut.import` + `lumetri.setInputLut` / `lumetri.setLook`; shot matching `lumetri.applyMatch`; check with `scopes.read`. Colour management: `sequence.settings {workingSpace}`.
7. Titles & captions: `graphics.newText {text, position, size, font, seconds}`; `transcript.generate` (whisper model) → `transcript.createCaptions` → `captions.setStyle`; `captions.export {path, format: srt|vtt|…}`.
8. Sound: `essentialSound.setType {type: dialogue|music|sfx|ambience}`, `essentialSound.autoMatch {target LUFS}`, `essentialSound.generateDucking`, `essentialSound.set` (noise repair, EQ, reverb); track mixer `mixer.setStrip` / `mixer.addInsert`; clip gain `clip.audioGain`; narration `tts.create {text, voice, pace}`.
9. Export: `file.exportMedia {path, preset | format, …, wait:true}` or CLI `export`. Presets include H.264 YouTube/Vimeo 1080p/4K, Social Vertical 1080×1920, ProRes 422/HQ/4444 (with alpha), DNxHR, image sequences (PNG/TIFF/EXR/DPX), GIF, WAV/AIFF/AAC/FLAC. Options: `loudnessLufs`, `burnCaptions`, `captionSidecar`, `alpha`, `crf`. Interchange: `file.exportFcpxml`, `file.exportOtio`, `file.exportEdl`, `file.exportAaf`. Stills: `file.exportFrame`.
10. Review the export (`review-media` skill), then report paths.

## Professional workflow

Distilled from how a studio-grade agent drives Premiere: build the cut from a clean interchange description, link every clip, keep titles as editable text, change an existing sequence in place instead of rebuilding it, and verify the export. Ids below were checked against `filmcraft-cli` 0.14; behaviour beyond their documented params is untested.

**Choose footage and cut points first** by reviewing the media locally (`edit-video` skill, `review-media`), then:

**New cut**: `file.newProject`, `file.newSequence {width,height,fps,sampleRate}` matching the delivery, `file.newBin`, `media_import`; place back to back with `timeline.place {items, track, seconds}` (one undo step); link picture and sound (`clip.link`); put titles on `graphics.newText` (text, never rendered images); interchange: FilmCraft exports FCP7 XML, FCPXML, OTIO, EDL and AAF (`file.exportFcp7Xml`, `file.exportFcpxml`, `file.exportOtio`, `file.exportEdl`) and imports AAF (`file.importAaf`); gap: no verified command to import FCP7 XML / OTIO into a project, so build the sequence natively with `timeline.place` and hand a Premiere user an exported XML.
**Existing sequence**: edit in place (titles with `graphics.newText` and `effects.setParam`, fades via `sequence.applyVideoTransition` / `effects.addKeyframe`, music, markers via `markers.add`); never rebuild the timeline, never edit a project file the app has open.

**Session loop**

1. `sequence_inspect` (ids, clip times in ticks and frames, effects, transitions, markers) before touching anything. Act on ids it returned.
2. One edit group, then look: `render_frame {seconds}` on both sides of every cut you changed, on every graded clip and every title (at 100 %).
3. Save versioned takes: `file.saveAs ...-v02.fcproj`; export to `takes/` with a suffix.
4. Offline media is a failure: fix with `media.findMissing` / `media.relink`; never deliver with `--allow-offline`.

**Timeline structure recipe**: V1 picture, V2 inserts/B-roll, V3 titles and graphics, V4 grade/adjustment-style effects on a nested layer; A1 dialogue, A2 music, A3 effects, A4 ambience; add tracks with `sequence.addTracks {video, audio, audioType}`; nest complicated sections with `clip.nest`; set targets with `timeline.setTargeting`. Trim in order: rough placement, then `timeline.trim` (ripple), `timeline.roll`, `timeline.slip`, close gaps `sequence.closeGap`, delete with `edit.rippleDelete`. Speed: `clip.speedDuration {speed, interpolation}`; reframe: `clip.scaleToFrameSize` and motion params via `effects.setParam {effect:"motion"}`.

**Colour**: match shots first (`lumetri.applyMatch`), then a creative look (`lumetri.applyPreset` / `lumetri.setLook`), read `scopes.read` (waveform, parade, vectorscope): skin tone along the skin line, whites below clip, blacks not crushed; apply grade on matching clips by copying effects rather than regrading each. Compare before/after frames from `render_frame`.

**Audio (ducking and loudness)**: tag every clip (`essentialSound.setType {type: dialogue|music|sfx|ambience}`), repair dialogue with `essentialSound.set`, level it (`essentialSound.autoMatch` to a target LUFS: about -16 LUFS stereo online, -23 broadcast), then music ducks under dialogue with `essentialSound.generateDucking {clips}` (keyframes on the music clips; verify them in `sequence_inspect` and by listening on a render). Fine control: `clip.audioGain`, `mixer.setStrip`, `mixer.addInsert`, automation lanes `mixer.setKeyframe`. Add `sequence.applyAudioTransition` (constant power) at music in/out. Check `clip.audioPeak` for clipping.

**Captions**: `transcript.generate`, `transcript.createCaptions`, `captions.setStyle`, `captions.export {format:"srt"}`; burn-in via export option `burnCaptions`.

**Export presets**: `file.exportMedia {path, preset, wait:true}`; CLI `export --list-presets` for names. Typical: H.264 YouTube 1080p/4K, Social Vertical 1080x1920, ProRes 422 HQ master (4444 with alpha), plus `loudnessLufs` for a normalised mix. Always export a master and a delivery compression, and check: `file.exportFrame` of the first and last frame, `ffprobe` (size, fps, duration, audio streams, loudness via `ffmpeg -af ebur128`), decode test (`ffmpeg -v error -i out.mp4 -f null -`).

**Gaps**: no verified reframe/auto-reframe or scene-detect command; no silence-removal id (use `transcript.*` plus `timeline.razor`, or ffmpeg `silencedetect`); no dedicated multicam beyond `clip.createMulticam`; speech-to-text needs a downloaded whisper model.
