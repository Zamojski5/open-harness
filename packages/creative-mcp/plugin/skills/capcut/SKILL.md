---
name: capcut
description: Prepare a CapCut handoff — edit, subtitle and narrate with our own tools, then deliver a project folder (clips, voice-over, music, UTF-8 SRT, order notes) the user finishes in CapCut desktop, web or phone. Use when the user says they finish videos in CapCut.
---

# CapCut

Status: **untested here** (CapCut not installed). Proprietary (ByteDance). There is no scripting API, and CapCut doesn't open other editors' project files.

## Clarify up front

- Where will they finish — CapCut on the desktop, in the browser, or on a phone?
- Target: running time, aspect ratio, captions yes/no.
- A request like "make it in CapCut" is not permission to operate CapCut's UI; ask separately before using `computer-use` on it.

## Most of the work happens before CapCut

Pick takes after local review (`media_inspect`, `media_frames`, `media_review`). Build the edit, subtitles and narration with `edit-video` and `voiceover-and-sound`. CapCut is then only for the user's last polish.

## Handoff folder `takes/capcut-<name>/`

- Numbered clips in play order (`01-…mp4`, `02-…mp4`) or one assembled picture file.
- Voice-over and music as their own WAV files, not baked into the clips.
- `captions.srt` in UTF-8, timed against the assembled cut. Desktop and browser CapCut can import SRT; the mobile app can't import subtitle files, so for phone either burn the captions in or rely on CapCut's auto-captions.
- `README.txt`: order, trims, the start time of each audio file, aspect ratio, target length.

## Limits

No CapCut bridge; finishing happens in the user's hands.
