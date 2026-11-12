# Editing a capture

| Route              | Start                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| ffmpeg             | `edit-video` (cuts, speed, captions, delivery) with the timing rules below                                            |
| EffectCraft        | import the files as footage layers; zooms, highlights, cursor callouts and facecam as layers (`make-motion-graphics`) |
| Kdenlive / Resolve | when the user wants an editable timeline (`kdenlive`, `davinci-resolve`)                                              |

## Timing rules

- Place every file on the capture clock using its start offset from `capture.json`; screen, camera and mic need not start at the same moment.
- Apply one ordered list of cuts, speed changes and repeats to **all** tracks — screen, camera, cursor overlays and audio — so they stay in sync. Segments are half-open (start included, end excluded): an event exactly on a boundary belongs to the following segment.
- When speech was edited by transcript (`edit-video` speech edits), that edit's timeline is the master: apply its cuts to the picture, use the already-edited audio without retiming it again, replace the original dialogue track with it, and use its output-timed captions.
- Zoom and facecam animation is authored on the output timeline by default; if it was keyed against the source, map the keys through the same cuts.
- Share any crop/zoom of the screen with overlays drawn on it (cursor highlight, callout boxes), or they drift.
- Per-frame mattes (background removal) carry their own timestamps in camera-media time: add the camera's start offset before applying cuts, hold each matte frame until the next timestamp, and use identical crop and mirror for camera and matte.
