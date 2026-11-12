---
name: remotion
description: Make videos in React with Remotion — set up a project per piece, cut and frame footage inside compositions, animate with frames and interpolate, render stills, ranges and finals (incl. ProRes 4444 alpha overlays), and review every cut. Use for code-driven or data-driven video, templated variants, screen-recording edits and overlays.
---

# Remotion

Status: **untested here** (not installed; npm `remotion` is at 4.0.539). Source-available: free for individuals and small teams, a company licence above that — mention it. Uses Node (installed) and downloads Chrome Headless Shell on the first render.

## Project

- One folder per piece, `./<piece>/motion/`, created with `npx create-video@latest` (blank template). Pin every `remotion` and `@remotion/*` package to the **same exact version**, plus a matching `react`/`react-dom`. Installing takes minutes; allow a long shell timeout and simply rerun if it was cut off.
- Read the brand kit (`brand-kit`) before the first frame and use its palette, fonts and logos.
- Remotion publishes official agent skills ("remotion-best-practices"); load them for craft if the user has them installed. On previews and delivery this file wins: stills are checkpoints, and the job is done only when the full render exists.
- Version notes: from 4.0.530, a Sequence/media `durationInFrames` measures **source** frames before `playbackRate`, so on screen it lasts `durationInFrames / playbackRate`. For VP8/VP9/AV1 WebM, `--buffer-size` only works together with `--video-bitrate`.

## Code rules

- Every animated value is a function of `useCurrentFrame()` via `interpolate()` / `spring()`. CSS transitions, keyframe animations and Tailwind `animate-*` classes are ignored by the renderer.
- Code is bundled for Chrome 85, so top-level `await` breaks the build. Load fonts with `loadFont()` (`@remotion/google-fonts/<Family>` or `@remotion/fonts`) at module level, once per weight/style, without awaiting.
- Motion and push-ins use `transform`/`scale` fed directly by interpolate. Animating `left`, `top`, `width`, `height` or margins, rounding animated numbers, or setting `willChange` all produced whole-pixel stepping in Linux renders. Slow zooms on live text panels jitter because the text re-lays out each frame — export the settled panel once (`still --scale=2`) and zoom the image.
- Set the composition fps to the footage's real rate (`ffprobe` `r_frame_rate`; generated clips are often 24). Mismatched rates duplicate frames.
- No ffmpeg `zoompan` for zooms — it crops on integer pixels and stutters.

## Footage lives in the composition

- `cp` each source file, complete, into `public/footage/` (a symlink 404s during render). All trimming happens in code. The one allowed ffmpeg step is converting a file the browser can't decode (ProRes gives `ProResDecoderNotEnabledError`) to H.264 + AAC; check `ffmpeg -encoders` and use `h264_videotoolbox` if `libx264` isn't there.
- Trim with `trimBefore` on `<Video>` (`@remotion/media`); the enclosing `<Sequence durationInFrames>` sets where it ends.
- Framing a screen recording: wrap it in a box whose pixel size has the recording's aspect ratio, scaled to the composition from `useVideoConfig()` and centred inside an `overflow: hidden` container. Without that, a 16:10 capture inside 16:9 gets letterboxed and percentage offsets land in the wrong place. Zoom and crop by `scale` + `transformOrigin` on the box; plain edge crops via the video's crop props.
- Hiding private details: an opaque element positioned in % inside that same box (so it zooms along), padded past the detail, in its own `<Sequence>` if it's only needed briefly. Never burn it in with `drawbox`.
- Holding the final frame: extend the Sequence past the played frames and put a `<Freeze>` around the `<Video>`, active from the first frame after playback (the hold has no sound). Never `tpad`.

```tsx
// sketch: show source seconds 2–5 of a 1440x900 capture, zoomed 20 %, then freeze for 1 s
export const Clip: React.FC = () => {
  const { fps, height } = useVideoConfig();
  const played = 3 * fps;
  const boxWidth = height * (1440 / 900);
  return (
    <Sequence durationInFrames={played + fps}>
      <AbsoluteFill
        style={{
          background: "#0b0b0f",
          overflow: "hidden",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            width: boxWidth,
            height,
            position: "relative",
            transform: "scale(1.2)",
            transformOrigin: "50% 10%",
          }}
        >
          <Freeze frame={played - 1} active={(f) => f >= played}>
            <Video
              src={staticFile("footage/capture.mp4")}
              trimBefore={2 * fps}
              style={{ width: "100%", height: "100%" }}
            />
          </Freeze>
        </div>
      </AbsoluteFill>
    </Sequence>
  );
};
```

## Voice-over

Keep an approved narration as a single uninterrupted `<Audio>` and hang the visuals on its word timings. Chopping it into per-line clips or padding gaps clips syllables (word end times tend to fall late inside pauses). To change spacing, edit the take itself (`voiceover-and-sound`) and retime.

## Render

```bash
npx remotion still src/index.ts Main out/check/scene2.png --frame=150
npx remotion render src/index.ts Main out/check/range.mp4 --frames=150-240
npx remotion render src/index.ts Main out/final.mp4
# alpha overlay for an editor — the composition must not paint a background:
npx remotion render src/index.ts Overlay out/overlay.mov --image-format=png --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le
```

`export-html` gives a standalone preview where the installed CLI has it (`--all-public` if it reports skipped `public/` files). Keep rendering checks while you build, but don't stop there.

## Review before presenting

1. `media_review` on the final (flags explained in `review-media`) and `media_inspect` for fps, duration, streams; make sure no source is enlarged beyond its own resolution at the deepest zoom.
2. Contact-sheet every edit point at full frame rate with system ffmpeg (Remotion's bundled ffmpeg lacks most filters). For a hard cut at second `T`:
   `ffmpeg -v error -ss $(echo "$T-0.5"|bc) -i out/final.mp4 -t 1 -vf "scale=320:-2,tile=6x5" out/check/cut_${T}_%02d.png` (30 frames per sheet; 60 fps needs two sheets).
   For a transition from `S` to `E`, start 0.2 s before `S` and run `E-S+0.4` seconds, sheets numbered in order.
   Look at every sheet: elements lingering after their scene, wrong overlaps, single-frame flashes, jumps or empty frames — fix them.
3. If speech was trimmed anywhere, compare the cut points with the take's word timings: no cut inside a word, no stray word fragments. Check the voice stem, since music masks gaps.
   Licences/credits: `craft` rights-and-sources.

## Limits

No managed runtime: we pin and install with npm ourselves; brand motion/font helpers aren't generated; splice checking and voice repair are manual (`voiceover-and-sound`).
