---
name: descript
description: Move work into and out of Descript — prepare media for import and take exports (rendered video/audio or a timeline for another editor) back into the project. Use when the user edits in Descript.
---

# Descript

Status: **untested here** (Descript not installed). Proprietary and cloud-based; no local scripting API.

- A Descript project isn't a local file we can open: it's stored in the user's Descript Drive.
- **Into Descript**: we prepare the media (clips, VO, music) in `takes/`; the user imports it.
- **Out of Descript**: the user exports either a finished video/audio render or a timeline for another NLE; we continue with `davinci-resolve`, `premiere-pro`, `final-cut-pro` or `edit-video`, and check files with `media_inspect`, `media_frames`, `media_review`.
- Don't offer edits inside Descript. Operating its UI (`computer-use`) only when the user explicitly asks for that.

## Limits

No Descript bridge.
