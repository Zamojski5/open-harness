---
name: ableton-live
description: Work alongside Ableton Live — plan changes to the open Live set, measure exported audio, and (only with a control-surface bridge the user installs) read and change the set through Live's Object Model. Use when the user produces music in Ableton Live.
---

# Ableton Live

Status: **untested here** (Live not installed). Proprietary (Ableton). **We have no Live bridge** — see Limits.

## Hard rules

- Don't operate Live through simulated keys or clicks, AppleScript, or by rewriting `.als` set files.
- The user keeps working in the set while we help, so any snapshot we hold goes stale. Get a fresh reading before proposing changes and again after something fails; don't carry track/device names or values over from earlier.
- We can't save the set — remind the user to save in Live.
- We can't listen. Report measured numbers only.

## Official interfaces

- The **Live Object Model (LOM)** — Live's documented object tree (`song`, `tracks`, `clip_slots`, `devices`, `parameters`, `mixer_device.volume`, …). It's reachable from **Max for Live** devices (Suite or the M4L add-on) and from Python **MIDI Remote Scripts** (control surfaces) that the user installs into Live's Remote Scripts folder and enables as a control surface in Live's preferences.
- LOM limitation worth knowing: arrangement clips can't be given automation directly. Write the envelope on a session-view clip and copy it into the arrangement with `track.duplicate_clip_to_arrangement`; the arrangement copy carries the envelope even though reading it back may give `None`.

## Without a bridge

1. The user exports (Live's Export Audio/Video, WAV): the full mix or one file per track, and gives us the path.
2. We measure — `media_review` or ffmpeg `ebur128` for integrated LUFS and true peak — and propose the fix as a change _in the set_ (which fader, how many dB) rather than processing the bounce.
3. Changes are written as an exact list per track/device for the user to apply.
4. New material comes from `make-music` / `voiceover-and-sound` as WAV files to drop into the set.

## Limits

No way to read or change the live set ourselves: no state readout, no batched/undoable edits, no device or preset loading, no bounce. Filling this needs a Remote Script or Max for Live device talking to a local socket — not built.
