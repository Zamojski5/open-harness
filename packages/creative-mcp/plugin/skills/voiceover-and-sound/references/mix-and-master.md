# Mixing, ducking, mastering, export

## Full mix in one pass (verified)

Voice from 2.0 s, drone bed under everything with ducking, boom at 0.5 s, 14 s total:

```sh
ffmpeg -i takes/vo-01.wav -i takes/drone.wav -i takes/boom.wav -filter_complex "\
[0:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,adelay=2000:all=1,apad=whole_dur=14[vo];\
[vo]asplit=2[vomix][vokey];\
[1:a]atrim=0:14,volume=-6dB[bed];\
[bed][vokey]sidechaincompress=threshold=0.01:ratio=8:attack=20:release=400:level_sc=4[ducked];\
[2:a]adelay=500:all=1,volume=-3dB[hit];\
[vomix][ducked][hit]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.89[mix]" \
-map "[mix]" -ar 48000 -c:a pcm_s24le takes/mix-take-01.wav
```

Pattern: normalise format → place (`adelay` ms, `all=1`) → set length (`apad=whole_dur` on the first input + `duration=first`, or `atrim`) → balance (`volume`) → duck → `amix=normalize=0` → `alimiter` → 24-bit WAV.

- Multiple voice lines: give each its own `adelay` and `amix` them into one `[vo]` (`amix=inputs=N:normalize=0`) before `asplit`.
- Per-input gain inside amix: `amix=inputs=3:weights='1 0.5 0.8':normalize=0`.
- Fade the bed: `afade=t=in:d=2,afade=t=out:st=<end-3>:d=3` on `[bed]` before ducking.
- Cut a music bed to length on a musical boundary: bar length = 240 / BPM s (4/4). Trim at a bar and fade the last 1–2 s.

## Ducking parameters

| Parameter | Start with | Notes |
|---|---|---|
| threshold | 0.01 (≈ −40 dBFS) | linear 0–1; lower = ducks on quieter speech |
| level_sc | 4 | sidechain (key) gain; raises how hard speech drives the duck |
| ratio | 8 | 4 = gentle, 20 = near-limiting |
| attack | 20 ms | 5–10 ms for punchy VO; too fast clicks on bass |
| release | 300–500 ms | longer = bed returns smoothly between sentences |
| makeup | 1 (default) | set the bed level with `volume`, not makeup |

Measured on a −6 dB drone bed with Zosia VO (attack 20, release 400), 2 s speaking windows, bed RMS without ducking −27.9 / −26.8 dB:
- `threshold=0.01:ratio=8:level_sc=4` → −37.5 / −37.6 dB (**≈ 10 dB**, recommended)
- `threshold=0.03:ratio=8` → −33.7 / −30.0 dB (3–6 dB, light)
- before the voice starts and after it ends: unchanged.
Aim for 8–12 dB under narration; 4–6 dB when the music matters (trailer, montage).

Check the depth (same window, with vs without ducking):
```sh
ffmpeg -i takes/drone.wav -i takes/vo-01.wav -filter_complex "\
[0:a]atrim=0:14,volume=-6dB[bed];[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=2000:all=1,apad=whole_dur=14[k];\
[bed][k]sidechaincompress=threshold=0.01:ratio=8:attack=20:release=400:level_sc=4,atrim=4:6,astats=measure_overall=RMS_level:measure_perchannel=none" -f null - 2>&1 | grep 'RMS level'
```
Replace the sidechain with `[k]anullsink;[bed]atrim=4:6,astats=…` for the un-ducked reference. Pick a window where the voice is speaking and the bed is not fading.

Simple alternative without sidechain: automate with `volume='if(between(t,2,9),0.3,1)':eval=frame` (hard steps — add `afade`s or use the compressor for smooth moves).

## Mastering

`<skills-dir>` = the parent folder of this skill; the script lives in the sibling `edit-video` skill.

```sh
bash <skills-dir>/edit-video/scripts/loudnorm2pass.sh takes/mix-take-01.wav takes/master-take-01.wav -16 -1.5   # voice-led
bash <skills-dir>/edit-video/scripts/loudnorm2pass.sh takes/mix-take-01.wav takes/master-take-01.wav -14 -1     # music-led / social
```
Exit 3 = missed target; follow the printed gain-correction command. Verified on the mix above: −18.2 → −15.1 LUFS (PASS, within 1 LU of −16), true peak −1.9. Dynamic-mode results often land ~1 LU hot; if the platform is strict, trim with `volume=-0.9dB`.

Quick numbers on any file:
```sh
ffmpeg -hide_banner -nostats -i f.wav -af ebur128=peak=true -f null -                                   # I, LRA, true peak
ffmpeg -hide_banner -i f.wav -af astats=measure_overall=RMS_level+Peak_level:measure_perchannel=none -f null -  # RMS/peak
```

## Export

| Use | Format | Command tail |
|---|---|---|
| Master / archive / hand-off to editor | WAV 48 kHz 24-bit | `-ar 48000 -c:a pcm_s24le x.wav` |
| Delivery audio file | AAC 192–256k | `-ar 48000 -c:a aac -b:a 192k x.m4a` |
| Podcast / universal | MP3 | `-ar 48000 -c:a libmp3lame -b:a 192k x.mp3` (check `ffmpeg -encoders | grep mp3`) |
| Onto a video | AAC in MP4 | `ffmpeg -i video.mp4 -i master.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart takes/final-take-01.mp4` |

Encode to AAC/MP3 only once, from the WAV master. Make the master the exact length of the video (`apad`/`atrim`) so `-shortest` doesn't cut a tail you wanted.
