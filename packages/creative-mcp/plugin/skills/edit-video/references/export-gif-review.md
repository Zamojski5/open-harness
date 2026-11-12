# Platform exports, GIFs, review sheets

## Delivery encode

```
-c:v libx264 -profile:v high -preset slow -crf 20 -pix_fmt yuv420p -r 30 \
-c:a aac -b:a 192k -ar 48000 -movflags +faststart
```

- CRF: 18 = visually lossless master, 20 = default delivery, 23 = small preview. Lower CRF for grain/noise/fast motion.
- Size-capped platforms: add `-maxrate 8M -bufsize 16M` (1080p30), `-maxrate 12M -bufsize 24M` (1080p60), `-maxrate 40M -bufsize 80M` (4K).
- 60 fps only if the source is 60 (screen recordings, game/Blender renders at 60). Otherwise keep 24/25/30; set GOP ≈ 2 s (`-g 60` at 30 fps, `-g 120` at 60).
- `+faststart` moves the index (moov) to the front so playback starts before download — required for web.
- Audio: AAC-LC 48 kHz stereo, 192k (music-heavy: 256–320k).

## Reframing 16:9 → 9:16 / 1:1 / 4:5

```sh
# centre crop to 9:16 (subject central)
ffmpeg -i in.mp4 -vf "scale=-2:1920,crop=1080:1920,setsar=1" <delivery args> takes/vertical-crop-take-01.mp4
# off-centre crop: crop=1080:1920:x=<left px>:y=0 (x from 0 to iw-1080; check a frame first)

# blur-fill: whole frame visible, blurred copy fills the bars
ffmpeg -i in.mp4 -filter_complex "[0:v]split[bg][fg];\
[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.08[bgb];\
[fg]scale=1080:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]" \
-map "[v]" -map 0:a <delivery args> takes/vertical-blur-take-01.mp4

# square with bars (pad)
ffmpeg -i in.mp4 -vf "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1" <delivery args> takes/square-pad-take-01.mp4
# square centre crop
ffmpeg -i in.mp4 -vf "crop=ih:ih,scale=1080:1080,setsar=1" <delivery args> takes/square-crop-take-01.mp4
# 4:5 feed crop
ffmpeg -i in.mp4 -vf "scale=-2:1350,crop=1080:1350,setsar=1" <delivery args> takes/feed45-take-01.mp4

# vertical → horizontal with blur-fill
ffmpeg -i v.mp4 -filter_complex "[0:v]split[bg][fg];\
[bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=30[bgb];\
[fg]scale=-2:1080[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]" -map "[v]" -map 0:a <delivery args> takes/horizontal-take-01.mp4
```

Decide crop vs fill by looking: `media_frames` the source, find where the subject sits over time. If it moves across the frame, a static crop will lose it — use blur-fill, or split into segments with different `x` and concat. If the delivery will also get captions, reframe first and caption the final size.

Safe areas for 9:16 (1080x1920): keep important content within x 65–955, y 270–1500 (UI covers top ~14%, bottom ~20%, right-side buttons).

## GIF

```sh
# one pass, good default (15 fps, 480 px wide)
ffmpeg -ss 1 -t 3 -i in.mp4 -filter_complex "fps=15,scale=480:-1:flags=lanczos,split[a][b];\
[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 takes/loop-take-01.gif
# two pass with a saved palette (better for long or colourful clips)
ffmpeg -ss 1 -t 3 -i in.mp4 -vf "fps=15,scale=480:-1:flags=lanczos,palettegen=stats_mode=full" takes/work/pal.png
ffmpeg -ss 1 -t 3 -i in.mp4 -i takes/work/pal.png -lavfi "fps=15,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" -loop 0 takes/loop-take-02.gif
```

Size levers, in order: shorter duration, lower fps (10–15), narrower width (320–480), fewer colours (64–128), `bayer` dither (compresses better than error diffusion). Measured: 3 s 480x270 test pattern = 0.44 MB (bayer, 128 colours) vs 0.64 MB (sierra, full palette). For anything over ~5 s or > 5 MB offer an MP4/WebM loop instead.

## Review

- `media_frames path=<file> frames=12..24 columns=4..6` after every render. Look for: black or duplicated frames at joins, transitions in the right places, captions inside safe areas and readable, framing on 9:16.
- Exact frame at a time: `ffmpeg -ss 4.0 -i out.mp4 -frames:v 1 takes/work/f4.png` then Read the PNG. Several side by side: `-i f1.png -i f2.png -filter_complex hstack=2`.
- Shot-change sheet (one thumbnail per cut; `eq(n,0)` guarantees at least the first frame; write PNG, not JPG):
  `ffmpeg -i in.mp4 -vf "select='eq(n,0)+gt(scene,0.3)',scale=360:-1,tile=4x3:padding=4" -fps_mode vfr -frames:v 1 takes/work/cuts.png`
  Cut times: `ffmpeg -i in.mp4 -vf "select='gt(scene,0.3)',showinfo" -an -f null - 2>&1 | grep -o 'pts_time:[0-9.]*'`. Crossfades and similar-looking shots score low — lower to 0.15 if cuts are missed.
- Final checks with `media_inspect`: duration as planned, `pix_fmt=yuv420p`, expected WxH and fps, SAR 1:1, audio stream 48000 Hz present.
