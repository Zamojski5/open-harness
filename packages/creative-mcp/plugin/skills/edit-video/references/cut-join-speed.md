# Cutting, joining, transitions, speed

All commands are shown as shell lines; for the MCP `ffmpeg` tool drop the leading `ffmpeg` and pass every token as one array element (the tool adds `-hide_banner -y`). Quotes in shell lines are shell quoting only — do not include them in array elements.

## Probe

```sh
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height,sample_aspect_ratio,r_frame_rate,pix_fmt,sample_rate,channels -of compact in.mp4
# keyframe times (copy-trims can only start here)
ffprobe -v error -select_streams v -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 in.mp4
```

## Trim

```sh
# fast, lossless, keyframe-aligned (start snaps back to the previous keyframe)
ffmpeg -ss 2.5 -i in.mp4 -t 3 -c copy -avoid_negative_ts make_zero takes/clip-take-01.mp4
# frame-accurate (re-encode). -ss before -i is fast AND accurate when re-encoding.
ffmpeg -ss 2.5 -i in.mp4 -t 3 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k takes/clip-take-02.mp4
```

Use copy for rough pulls from long recordings, re-encode for anything that will be cut against music or another shot. If you need lossless *and* exact, re-encode only the head up to the first keyframe — usually not worth it.

## Join

Same parameters (check with the probe above) → concat demuxer, no re-encode:

```sh
printf "file 'part1.mp4'\nfile 'part2.mp4'\n" > takes/work/list.txt
ffmpeg -f concat -safe 0 -i takes/work/list.txt -c copy takes/joined-take-01.mp4
```

Paths in the list are relative to the list file. Different sizes/fps/audio → concat filter, normalising every input to the delivery format:

```sh
ffmpeg -i a.mp4 -i b.mp4 -filter_complex "\
[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0];\
[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v1];\
[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];\
[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];\
[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
-map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac -b:a 192k takes/joined-take-02.mp4
```

Verified: 1920x1080@30 + 1280x720@25 (mono 44.1k) → 16.0 s, 1920x1080@30, AAC 48k stereo.

A clip without audio: add `-f lavfi -t <dur> -i anullsrc=r=48000:cl=stereo` as an extra input and use it in place of `[N:a]`.

## Crossfades

```sh
# A = 10 s, B = 6 s, 1 s fade → offset = 10 - 1 = 9, result 15 s
ffmpeg -i a.mp4 -i b.mp4 -filter_complex "\
[0:v][1:v]xfade=transition=fade:duration=1:offset=9,format=yuv420p[v];\
[0:a][1:a]acrossfade=d=1:c1=tri:c2=tri[a]" \
-map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac takes/xfade-take-01.mp4

# three clips 10/6/10 s, 1 s fades → offsets 9 and 9+6-1 = 14, result 24 s
ffmpeg -i a.mp4 -i b.mp4 -i c.mp4 -filter_complex "\
[0:v][1:v]xfade=transition=wipeleft:duration=1:offset=9[x1];\
[x1][2:v]xfade=transition=fade:duration=1:offset=14,format=yuv420p[v];\
[0:a][1:a]acrossfade=d=1[a1];[a1][2:a]acrossfade=d=1[a]" \
-map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac takes/xfade-take-02.mp4
```

General: `offset_k = (d_1 + … + d_k) − k × fade`. Useful transitions: `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft/right/up/down`, `slideleft`, `smoothleft`, `circleopen`, `radial`, `zoomin`, `pixelize`. Keep 0.3–0.5 s for energetic edits, 0.8–1.5 s for calm ones; prefer hard cuts on the beat and save crossfades for time/place changes.

Both xfade inputs need identical WxH, fps, pix_fmt — normalise with the chain from "Join" first.

## Speed

```sh
# 2x
ffmpeg -i in.mp4 -filter_complex "[0:v]setpts=PTS/2[v];[0:a]atempo=2[a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac takes/fast-take-01.mp4
# 0.25x of the first 2 s (note -t BEFORE -i) → 8 s
ffmpeg -t 2 -i in.mp4 -filter_complex "[0:v]setpts=PTS*4[v];[0:a]atempo=0.5,atempo=0.5[a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac takes/slow-take-01.mp4
```

Slow motion from normal footage stutters. Options, cheapest first: `framerate=fps=30` after setpts (frame blending), `minterpolate=fps=30:mi_mode=mci` (motion interpolation; slow — downscale or test on 1 s first; artefacts on fast motion). Real slow-mo needs high-fps source (re-render from Blender at 120 fps and `setpts=PTS*4`).

Silent speed changes: drop audio with `-an` and add music/SFX afterwards — sped-up voice rarely sounds good beyond 1.25x.

### Speed ramp (segment and concat)

```sh
# 0-3 s at 1x, 3-5 s at 0.5x, 5-10 s at 2x → 3 + 4 + 2.5 = 9.5 s
ffmpeg -i in.mp4 -filter_complex "\
[0:v]trim=0:3,setpts=PTS-STARTPTS[v0];[0:a]atrim=0:3,asetpts=PTS-STARTPTS[a0];\
[0:v]trim=3:5,setpts=(PTS-STARTPTS)*2[v1];[0:a]atrim=3:5,asetpts=PTS-STARTPTS,atempo=0.5[a1];\
[0:v]trim=5:10,setpts=(PTS-STARTPTS)/2[v2];[0:a]atrim=5:10,asetpts=PTS-STARTPTS,atempo=2[a2];\
[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]" \
-map "[v]" -map "[a]" -r 30 -c:v libx264 -crf 18 -c:a aac takes/ramp-take-01.mp4
```

For a smoother ramp use more, shorter segments (e.g. 0.25 s steps 1.0 → 0.8 → 0.6 → 0.5). `-r 30` keeps a constant output rate after the speed changes.
