---
name: audacity
description: Drive Audacity (open-source audio editor) by script via mod-script-pipe — import, trim, normalise, noise-reduce, apply effects/macros, export audio. Use when the user works in Audacity or wants interactive audio cleanup they can see; for plain batch audio processing prefer ffmpeg.
---

# Audacity

Status: **untested here** (Audacity not installed).

## Install / enable
- Install only with consent: `brew install --cask audacity`.
- Scripting needs **mod-script-pipe** enabled once: Preferences → Modules → `mod-script-pipe` = Enabled, restart Audacity. Audacity must be **running** (GUI); it is not a headless CLI.
- Pipes on macOS/Linux: `/tmp/audacity_script_pipe.to.<uid>` and `/tmp/audacity_script_pipe.from.<uid>`.

## Minimal client (Python)
```python
import os  # untested
uid = os.getuid()
TO, FROM = f"/tmp/audacity_script_pipe.to.{uid}", f"/tmp/audacity_script_pipe.from.{uid}"
to, frm = open(TO, "w"), open(FROM, "r")
def cmd(c):
    to.write(c + "\n"); to.flush()
    out = []
    while (line := frm.readline()) != "\n":
        out.append(line)
    return "".join(out)
print(cmd('Import2: Filename="/abs/voice.wav"'))
print(cmd("SelectAll:"))
print(cmd("Normalize: PeakLevel=-1 ApplyGain=1 RemoveDcOffset=1"))
print(cmd('Export2: Filename="/abs/voice-clean.wav" NumChannels=1'))
```
Commands match menu items; list them with `cmd('GetInfo: Type=Commands Format=Brief')`. Selection: `Select: Start=1.0 End=4.5 Track=0`. Macros: `cmd('Macro_<Name>:')` runs a saved macro.

## Batch without Audacity (preferred, tested tool: ffmpeg)
- Loudness for web/podcast: `ffmpeg -i in.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 out.wav` (video platforms ≈ -14 LUFS).
- Denoise: `afftdn=nf=-25`; high-pass rumble: `highpass=f=80`; trim: `-ss 1.2 -to 9.8`.

## Pitfalls
- If the pipe files don't exist, the module isn't enabled or Audacity isn't running.
- Noise Reduction needs a noise profile step (GUI-oriented); use ffmpeg `afftdn` for scripted denoise.
