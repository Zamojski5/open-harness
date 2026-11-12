---
name: kdenlive
description: Build and render video edits with Kdenlive/MLT — write MLT XML (or .kdenlive projects) programmatically and render headlessly with melt. Use when the user edits in Kdenlive, wants an editable open-source NLE project from the agent's cut, or needs a scripted multi-track edit beyond simple ffmpeg concat.
---

# Kdenlive / MLT

Status: **untested here** (Kdenlive and `melt` not installed). Kdenlive projects (`.kdenlive`) are MLT XML with extra Kdenlive metadata; `melt` is MLT's CLI renderer.

## Install / detect
- `brew install --cask kdenlive` (consent first). The app bundles melt: `/Applications/kdenlive.app/Contents/MacOS/melt`. Standalone: `brew install mlt` (*untested formula availability*).

## Quick cuts with melt (no XML)
```bash
# untested
melt a.mp4 in=0 out=124 b.mp4 in=50 out=199 -mix 12 -mixer luma \
     -consumer avformat:out.mp4 vcodec=libx264 crf=18 acodec=aac ab=192k
```
`in/out` are frames; `-mix N -mixer luma` = N-frame dissolve between the last two clips.

## Minimal MLT XML (write it, then render)
```xml
<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0">
  <profile width="1920" height="1080" frame_rate_num="25" frame_rate_den="1"
           progressive="1" sample_aspect_num="1" sample_aspect_den="1"
           display_aspect_num="16" display_aspect_den="9" colorspace="709"/>
  <producer id="clip1"><property name="resource">/abs/shot1.mp4</property></producer>
  <producer id="clip2"><property name="resource">/abs/shot2.mp4</property></producer>
  <producer id="music"><property name="resource">/abs/music.wav</property></producer>
  <playlist id="v1">
    <entry producer="clip1" in="0" out="99"/>
    <entry producer="clip2" in="25" out="149"/>
  </playlist>
  <playlist id="a1"><entry producer="music" in="0" out="224"/></playlist>
  <tractor id="main">
    <track producer="v1"/>
    <track producer="a1" hide="video"/>
    <transition mlt_service="mix"><property name="a_track">0</property><property name="b_track">1</property></transition>
  </tractor>
</mlt>
```
Render: `melt edit.mlt -consumer avformat:out.mp4 vcodec=libx264 crf=18 preset=slow acodec=aac` *(untested)*.
Kdenlive can open plain MLT XML; for a native `.kdenlive`, start from a project saved by the user's Kdenlive version and edit its playlists (format details change between versions).

## Use it for
Handing the user an editable timeline of the agent's cut; multi-track edits with titles/filters (`<filter mlt_service="...">`); proxies of long edits.

## Pitfalls
- Frame-based `in/out` are inclusive; durations = out - in + 1.
- Profile fps must match the source or MLT retimes; set profile explicitly.
- Verify output with `media_inspect` / `media_frames`.
- For simple concatenation/trim, ffmpeg is faster and is installed.
