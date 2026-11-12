---
name: reaper
description: Script Cockos REAPER with one-shot Lua ReaScripts in a separate instance — open or create .rpp projects, edit tracks/items/FX, render mixes or stems. Use when the user works in REAPER or wants an editable multitrack audio project.
---

# REAPER

Status: **untested here** (REAPER not installed). Proprietary, cheap licence with an evaluation period. For plain audio processing prefer ffmpeg (`voiceover-and-sound`, `audacity`).

## Clarify up front

- New project or a given `.rpp`? If given, is it currently open in the user's REAPER?
- Output: the updated project, a mixdown, stems — in which format, to which loudness?
- Plugins the session depends on — are they installed here?

## One-shot script in a private instance

```bash
# untested
/Applications/REAPER.app/Contents/MacOS/REAPER -nosplash -newinst \
  -cfgfile /abs/project/takes/work/reaper.ini /abs/song.rpp /abs/project/takes/work/edit.lua
```

- Blank project: pass `-new` where the `.rpp` goes. Windows: `reaper.exe` in its install folder.
- `-newinst` starts a separate process, so the user's own REAPER session isn't touched. The throwaway `-cfgfile` shields their settings but has no licence or extensions in it — expect a possible evaluation nag window that stops startup; tell the user if nothing happens.
- REAPER doesn't exit when the Lua script ends. The script saves (`reaper.Main_SaveProjectEx(0, "/abs/song_v2.rpp", 0)`), writes a result file, and then we terminate that process. No `defer` loops and no modal dialogs in these scripts.
- Edits the user hasn't saved in their own window don't exist for our instance; never write over an `.rpp` they have open — save a new revision.
- Handy calls: `reaper.InsertMedia`, `GetTrack`, `TrackFX_AddByName`, `SetMediaTrackInfo_Value(tr, "D_VOL", gain)`; rendering by project render settings plus `Main_OnCommand(41824, 0)` (render with most recent settings) — confirm command IDs in the user's Actions list.

## Around it

Music: `make-music`; SFX/voice: `voiceover-and-sound`. Measure renders with `media_review` (integrated LUFS, true peak) and report numbers, not impressions.

## Limits

No speech-to-text tool built in (use a local whisper if installed). How it _sounds_ can't be judged by us; `choose-media-model` covers hosted understanding (paid upload).
