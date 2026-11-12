# Subtitles and burned-in captions

## Writing the SRT

```
1
00:00:00,500 --> 00:00:03,000
First caption line

2
00:00:03,500 --> 00:00:06,200
Second caption, may wrap
onto a second line
```

- UTF-8 (Polish diacritics are fine), comma before milliseconds, blank line between cues, numbering from 1.
- Max 2 lines, ~42 characters per line (16:9) or ~28 (9:16). Reading speed ≤ 17 characters/second; minimum cue 1.0 s, typical 1.5–6 s; leave ≥ 80 ms gap between cues.
- Break lines at phrase boundaries, not after articles/prepositions ("w", "na", "the", "a").
- Timing source: if you generated the voice-over line by line, each line's duration (`media_inspect`) plus its start offset gives the cue times directly. Otherwise review with `media_frames` / listen points from waveform (`showwavespic`) — never guess timing for speech you cannot see.
- Social short-form: 1–4 words per cue, centered, timed to speech rhythm ("karaoke" style is a series of short cues).
- From a word-timed transcript: end a cue at any pause of 500 ms or more and at every sentence end; no cue longer than 3 s or 48 characters, and take cue times from the words (script in [speech-edits.md](speech-edits.md#captions-from-the-transcript)).
- Generated narration: use the take's own word timings rather than guessing from line durations.

## Soft subtitles (viewer can toggle)

```sh
ffmpeg -i in.mp4 -i subs.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=pol takes/subbed-take-01.mp4
ffmpeg -i in.mp4 -i subs.srt -map 0 -map 1 -c copy -c:s srt takes/subbed-take-01.mkv
```

Most social platforms ignore embedded tracks — upload the .srt separately there, or burn in.

## Burn-in: check what this ffmpeg can do

```sh
ffmpeg -hide_banner -filters | grep -wE 'subtitles|ass|drawtext'
```

- `subtitles` / `ass` present (libass): `-vf "subtitles=subs.srt:force_style='FontName=Arial,FontSize=22,Outline=2,MarginV=60'"`.
- `drawtext` present (freetype): fine for one static title, painful for many cues.
- **Nothing listed (the case on this machine, ffmpeg 8.0.1):** use the PNG overlay route below. Don't try to install a different ffmpeg mid-session without asking the user.

## Burn-in via PNG overlays (always works)

`scripts/caption_png.py` (Pillow) renders each cue as a transparent PNG the size of the video, wraps long lines, adds an outline (or a box with `--box`), and writes `overlay.fg` — a filtergraph where input `N` (the Nth cue PNG) is shown with `enable='between(t,start,end)'`.

```sh
python3 <skill-dir>/scripts/caption_png.py subs.srt --size 1920x1080 --out takes/work/caps
#   options: --position bottom|top|center  --margin 0.08  --font-size 0 (auto)  --font PATH  --box  --max-width 0.86
ffmpeg -i in.mp4 -i takes/work/caps/cue_001.png -i takes/work/caps/cue_002.png \
  -/filter_complex takes/work/caps/overlay.fg -map "[vout]" -map "0:a?" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy takes/captioned-take-01.mp4
```

- Input order matters: video first, then the PNGs in cue order (`takes/work/caps/inputs.txt` lists them). The script prints the full argument list as JSON — paste it into the MCP `ffmpeg` tool after replacing `IN.mp4`/`OUT.mp4`.
- `--size` must equal the video's WxH (after any reframe — caption the final framing, not the source).
- Auto font size: 5% of the short side for landscape (54 px at 1080p), 7% of width for portrait (75 px at 1080x1920). Default font: Arial Bold (has Polish glyphs). Check one frame per cue: `ffmpeg -ss <mid-cue time> -i out.mp4 -frames:v 1 check.png` and Read it.
- Dozens of cues are fine; for hundreds, split the video into chunks.
- Styled/animated captions (pop-in, word highlight, brand fonts): build them as text layers in EffectCraft, render with alpha (or over the plate) and composite with `overlay`.

## Safe placement

- 16:9: bottom margin ≥ 8% of height; keep inside the central 90% width.
- 9:16 Reels/TikTok/Shorts: the bottom ~20% (caption, buttons) and top ~14% are covered by UI; right ~12% has the action buttons. `--position center` or `--margin 0.25` keeps captions clear.
