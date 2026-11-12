# AI-artifact checklist

Run on every generated image or video take before scoring it. **B** = blocker (fails the take unless cropped/cut out), **W** = warning (fix if visible at delivery size).

## How to look

- Stills: open the full image, then crop-zoom faces, hands, text and edges (`ffmpeg -i in.png -vf crop=W:H:X:Y,scale=iw*2:ih*2 zoom.png`, Read it).
- Video: `media_frames {path, frames: 16}` for the overview, then a dense pass on suspicious seconds (`media_frames` on a 1 s excerpt, or `ffmpeg -ss T -t 1 -vf fps=12,tile=4x3`). Look at the first and last 12 frames separately — warm-up and settle frames are where most morphing hides.
- Compare frame N with N+1 for flicker; compare shot A's last frame with shot B's first frame for continuity.
- Judge at delivery size too: a W that is invisible on a phone may be acceptable; a B never is.

## Checklist

| Area | What goes wrong | Sev | Typical fix |
|---|---|---|---|
| Hands | extra/missing/fused fingers, wrong joint bends, hands merging with objects | B if in focus | reframe (hands out of frame or in shadow), simpler pose, keyframe with correct hands, cut before the gesture |
| Faces | asymmetry that shifts frame to frame, melting during head turns, identity drift between shots | B | stronger face reference, shorter shot, slower head motion, image-to-video from a checked keyframe |
| Eyes | mismatched gaze, irises of different size, dead stare, blinking glitches | B in close-ups | regenerate keyframe; avoid extreme close-ups with motion |
| Teeth / mouths | too many teeth, single tooth strip, mouth shape wrong for speech | W (B if lip-sync matters) | closed-mouth acting, wider framing, avoid dialogue |
| Object permanence | objects appear, vanish or duplicate when occluded; props change shape or count | B | simpler blocking, fewer objects, cut on the occlusion, last-frame chaining for continuity |
| Morphing / warping | limbs or objects melt into each other; backgrounds bend; geometry "breathes" | B | slower camera move, shorter duration, fewer moving elements, different seed |
| Text | invented, garbled or misspelled lettering on signs, screens, packaging | B for anything readable | prompt "no text", add real text later in EffectCraft/HTML; for images use a model good at text and verify every letter |
| Logos / brand marks | distorted, re-drawn or hallucinated logos | B | never generate a logo — composite the real vector file in post |
| Physics | liquids, cloth, hair and smoke behaving wrongly; feet sliding; objects floating; wrong gravity or scale | W/B | less ambitious action, cut before contact, Blender for physics-heavy shots |
| Palette drift between shots | grade, white balance, saturation or time of day changes across a sequence | W | same palette words and reference in every prompt; unifying grade in EffectCraft; compare thumbnails side by side |
| Temporal flicker | texture boiling, brightness pumping, shimmering detail frame to frame | W (B if obvious) | different seed/model, lighter grain to mask, deflicker (`ffmpeg -vf deflicker=size=5`), shorter clip |
| Style drift | shot gets more "AI-glossy", plasticky skin, over-sharpened, HDR look | W | anchor with style reference image, keep style clause identical, add grain in finish |
| Anatomy / count | wrong number of legs/wheels/windows, impossible poses | B | regenerate; show fewer instances |
| Background crowds | faces smear, people merge, duplicate extras | W | shallow depth of field, fewer extras, blur in post |
| Camera | move not as asked, sudden zoom/jump, warped parallax | W | name a single move; image-to-video with clear depth; trim |
| Audio (models with sound) | gibberish speech, wrong language, music you didn't ask for, sync off | W | prompt "no dialogue, no music"; replace audio in post |

## Reporting

Write the result into `takes_log` notes as `artifacts: hands B @2.1s; flicker W bg` so later retakes can target the actual failure. When delivering a take with accepted W items, list them in the hand-off.
