---
name: screen-capture
description: Record the screen, a window or region, a camera and audio on macOS (OBS, screencapture, ffmpeg avfoundation), keep the takes as one portable folder, and style a presenter camera (circle/rounded PiP, border, shadow, mirror) over the recording. Use when the user wants a screen recording, tutorial capture, a demo take, a facecam overlay, or asks how to record their screen. OBS remote control details: obs.
---

# Screen capture

Recording works on **macOS only** here. On Windows/Linux, say so and ask for the user's own recordings; existing recordings can still be edited.

Routes, best first: **OBS** (`obs` skill — window or display, camera, mic and app/system audio in one scene, MKV that survives crashes) → `ffmpeg -f avfoundation` (display + mic, scriptable) → `screencapture -v` (quick display video, no audio). For product demos, `make-product-demo` decides whether recording is needed at all.

## Before recording

- **Permissions** (System Settings → Privacy & Security): Screen Recording, Camera, Microphone for the app that records (OBS, Terminal). Only the user can grant them; a fresh grant may need the app restarted. Check with a 2–3 s test take, not by assumption.
- **Devices and sources**: list them (`ffmpeg -f avfoundation -list_devices true -i ""`, OBS source list). Reuse the exact device/window/display the user chose; never silently substitute another window, display, camera or mic.
- **Windows**: bring the intended app on screen and restore a minimised window before filming. Offscreen or minimised apps can stop updating their content — verify with a short test take after bringing the window up. If the window isn't listed, activate the app and refresh before calling it unavailable.
- **System audio** records the whole output mix (other apps and notification sounds too), not the mic. macOS needs OBS's app/desktop audio capture or a loopback device (e.g. BlackHole) for it; avfoundation alone gets only the mic. Test it: play something audible, record a few seconds, and measure — a present audio stream can still be silent (`ebur128` / `volumedetect` on the test).
- **Region**: macOS coordinates are logical points; Retina pixels are 2×. Crop in pixels after recording (`crop=w:h:x:y`) or set the OBS crop.
- **Cursor**: either baked into the footage (OBS "show cursor", avfoundation `-capture_cursor 1 -capture_mouse_clicks 1`) or hidden. An editable cursor track (separate pointer positions and artwork to restyle later) is not available here.

## Recording

- Output goes where the user asked; otherwise into a fresh `captures/<name>-<YYYYmmdd-HHMMSS>/` folder (create the parent if needed). Never write into an existing take folder.
- Record screen, camera and mic as **separate files** when the tool allows it (OBS multiple tracks / a second avfoundation input to a second file) and write `capture.json` in the folder: each file, its role, start time on the shared clock and duration. Tracks need not start together; their offsets matter for the edit.
- All requested tracks must start. If one doesn't, stop and fix — a partial take is an error, not a success.
- A failed or uncertain take is never resumed or replayed automatically; record a new one into a new folder. Keep the original folder intact.

```sh
# display 1 + default mic, 30 fps, cursor and clicks visible (device indices from -list_devices)
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -capture_mouse_clicks 1 -i "1:0" \
  -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k captures/demo-20261030-141500/screen.mp4
# quick display video without audio (Ctrl-C or -V seconds to stop)
screencapture -v -V 30 captures/demo-20261030-141500/screen.mov
```

## After recording

- `media_inspect` every file (real fps — screen recordings are often VFR; convert with `-fps_mode cfr -r 30` before editing), `media_frames` to check the content, `ebur128` on the audio.
- Edit: [editing routes and timing](references/editing-routes.md). Presenter camera styling: [facecam](references/facecam.md). Someone talking: `edit-video` cut by transcript.
