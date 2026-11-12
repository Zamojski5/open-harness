# Resolve API traps (measured; re-check on the user's build)

Each was measured on a specific Studio build (19.1–21.1) by the open-source Resolve MCP project and others. Use them as strong priors and re-check on the build in front of you.

## Project and session

- Saving a project that was never named (Resolve calls it Untitled Project, sometimes with a date-time suffix) opens a Save-As dialog: in the GUI the script blocks until someone answers; **headless it never returns**. Name the project (or check the name) before saving.
- A Resolve that came up with **no project database attached** answers version/page queries normally but `CreateProject`/`LoadProject` return False forever → quit and relaunch (with the user), don't retry.
- `DeleteProject` fails on the open project; renaming the active timeline fails — switch away first.
- `timelineFrameRate` locks once any timeline exists. The **playback** frame rate has no API setter; at project setup (not at handover) the user changes it in Project Settings → Master Settings → Playback frame rate.
- Track indices are 1-based (`GetItemListInTrack("video", 1)`).

## Media pool

- `ImportMedia` has **no destination argument**: clips land in the _current_ folder. Create the bin, `SetCurrentFolder`, then import; restore the previous folder after.
- `CreateTimelineFromClips` can fail with a bare error unless the current folder holds the clips.
- Phone footage: a `rotation` flag makes 3840×2160 display as 2160×3840 — Resolve honours it, so don't reframe again. Phone clips are often VFR: match the timeline to the fps Resolve reports for the clip, not ffprobe's `r_frame_rate`.
- Audio (WAV) items count source frames at the rate the **project** had when the WAV was imported; read each item's own source rate rather than the timeline rate.

## Timeline editing

- Clip-info `endFrame` is **exclusive** (end = start + duration); inclusive math leaves a one-frame gap between every clip.
- Source fps ≠ timeline fps → Resolve floors the conversion; plan in timeline frames and add one source frame if a slot comes up short.
- **No clip-speed API** on any build: `SetProperty("Speed"…)` returns False; `SetRetime`-style calls only set retime quality yet return True. Route speed changes to the user.
- No public razor/split. `Insert*IntoTimeline` cannot choose a track (lands on V1).
- Reading the user's selection is unreliable before 21.0.4; an empty or partial result looks like a small selection, so read back which items you actually got before any destructive step.
- After destructive edits, re-check: zero gaps/overlaps **and** total duration **and** a few placements by source span.

## Colour

- `CopyGrades` **replaces** the target grade, returns True, keeps no version. Only on targets the user confirmed are disposable or uniform; save a still/DRX first.
- `ApplyGradeFromDRX` replaces the whole node graph (no append) and many wrappers default to V1 item 0 — always pass track/item explicitly.
- `GetNodeGraph(0)` returns False; call it without an index.
- CDL is slope/offset/power (+saturation), not lift/gamma/gain, and Resolve can't read it back.
- Frame-first: look at rendered frames (before/after at the same timecodes) before and after any grade. Display-referred frames only; log footage needs its transform first.

## Fusion

- On a media clip's comp, rendering needs `MediaOut` to be reachable from `MediaIn`; a MediaOut fed by a sourceless tool makes the render job **fail**. For text over picture, use a separate Fusion title clip.
- `TextPlus` `Font`/`Style` take **registered** family/style names, not a `.ttf` path; a project font file is not installed. Set `Font` before `Style`. Missing font → `Could not find font` in ResolveDebug.txt and a black frame through Merge/MediaOut. Prove one title before doing many.
- Don't use `comp.Render()` for proofs — it can raise a "Render completed!" modal even with Wait. Use a timeline still or a short timeline render.
- On some 21.0.x builds an API-added comp rendered identical to no comp; only a rendered frame proves it worked.
- Fusion Loader file pickers can pop up when tools are created; set the clip path immediately.

## Stills, thumbnails, gallery

- `ExportCurrentFrameAsStill` can return True and write an **all-black** image. If a proof is black: stop bulk writes and renders, check source media, fonts and the log, repair existing nodes.
- Clip thumbnails are per clip (same image for every frame) and need Resolve frontmost — not frame evidence.
- Gallery `ExportStills` needs the Gallery panel visible on the Color page; fails headless too.

## Render

- `SetRenderSettings` layers on top of whatever preset/Deliver state is loaded. An Audio Only preset + `ExportVideo: True` produced an MP4 with **no video stream**. Load a known base preset first and verify the _output_: `media_inspect` must show a video stream; suspiciously fast completion for a long timeline is a warning sign.
- Unknown render keys are ignored silently (incl. the 21.0.4-only keys).
- Studio 21.1 crashed in `AddRenderJob` on some script-built timelines (`LoadTimelineFilterToRecord`); Quick Export crashed the same install. After a crash: reopen, verify timeline, check queue and output before one retry.
- `ArchiveProject` crashed the same 21.1 build; for a portable handoff export a DRP + copy media + relink notes instead.
- Remove only the render jobs you created; wiping the whole queue destroys the user's jobs.

## Transparency (overlays from Remotion/HyperFrames)

- Import the ProRes 4444 `.mov`, then set the media pool clip property `Alpha mode` to `Straight` or `Premultiplied` (Remotion PNG-frame ProRes → Straight) and read it back.
- Import a re-render under a **new filename**; an old media-pool reference keeps the old file.
- If valid alpha still renders opaque, import a PNG sequence as one clip (StartIndex/EndIndex), match its fps, put it on its own track.
