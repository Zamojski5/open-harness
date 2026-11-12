---
name: make-product-demo
description: Software demos, tutorials, app promos, launch films and product walkthroughs from the real UI — screenshots, screen recordings or the interface rebuilt as motion — with readable, exact on-screen text. Use when the user wants a demo, tutorial, feature video, app promo, or a real screen shown on a laptop/phone in a generated scene. Company news without product screens: make-announcement-video.
---

# Make a product demo

Record only when it helps; many demos are better built from stills and rebuilt UI.

- **Quick walkthroughs and tutorials** (light production, live or separate narration): [references/walkthroughs.md](references/walkthroughs.md).
- **Polished product films** (real product states, a clear before → after, composed motion, targeted revisions): [references/product-films.md](references/product-films.md).
- **The user's real screen recording placed on a laptop/phone in a generated scene**: [references/screen-inserts.md](references/screen-inserts.md).
- Recording the screen: `screen-capture` (macOS); driving the app on camera: `computer-use`. On other systems use the user's own recordings.
- Their own footage of someone talking: `edit-video` (cut by transcript).
- Narration: `voiceover-and-sound` — check a voice route exists before scripting narration; without one, make a captions-led cut.
- Export review: `media_review`, then present with `present-results`.

## Keep the interface readable and exact

Every screen on screen is the real product — supplied screenshots/recordings, your own capture, or UI rebuilt from those. Animate it only with controlled moves (pan, zoom, crop, mask, highlight, a cursor path) and typeset all headlines, labels and callouts yourself.

- Video models (image-, reference- or text-to-video) never receive a product screenshot, and no model is asked to draw UI that must match the product — generated interfaces come back with mangled labels, again and again. Generated clips are only for shots without product UI (any incidental screen stays off or unreadable).
- When the user insists on a model animating or drawing their UI, warn once that the text may come out wrong and go ahead; the check below then applies to the genuine screens only.
- No screenshots and no access to the product? Ask for them before building.
- **Before delivering** (unless the user said not to review): grab a frame wherever UI text is visible and set it beside the source screen at delivery size; each label has to be legible and identical. If not, adjust scale, crop, blur or compression (more bitrate, slower move, tighter framing) and export again. If the source can't give readable text at delivery size, say so and offer crops or better source material.

## Source resolution

Anything shown full-frame or zoomed into needs more source pixels than the output frame and crop demand. A recording only has the pixels it was captured at; enlarging adds none. For browser stills, capture at the output size (or 2×):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1920,1080 --force-device-scale-factor=2 --screenshot=takes/work/screen-01.png "https://app.example.com/page"
```

(Pages behind a login need the user's own screenshots or a browser session they control.) Brand continuity comes from the user's own artwork and product references.

## Inspect screens and motion

A still catches illegible UI, missing fonts or a wrong product state, but jitter and transition glitches only show in motion. Render and look at a short motion range (`media_frames` on a 2–3 s render, `media_flicker` for pops) when diagnosing those. Check the actual rendered type — a font being installed doesn't mean the renderer used it. Live text in a slow zoom can micro-jitter where an image of the same panel doesn't; render the panel as an image layer if it does. To judge motion over time, A/V sync or sound, use [watch and listen](../choose-media-model/references/understanding.md) (paid upload). Share inspection frames as progress notes and keep building; your own inspection is not an approval request.

## A fast revision loop

In a long demo the time goes into the back-and-forth between tool calls more than into rendering, because each call makes the model process the full chat history again. So batch the checks and the shell work:

- **Iterate at half resolution.** Stills and short ranges are rendered at half the delivery size until the cut, timing and captions are locked.
- **Check a revision on one sheet.** A small script grabs every moment worth checking (each caption, each UI state, every cut, the end card) and tiles them into a single image (ffmpeg `select` + `tile`); view it once per revision. `media_frames` will do when evenly spaced samples are enough. No still-by-still looks, and no extra sheet to re-check what the first one already showed.
- **Keep the routine in a script.** One re-runnable file does the export, loudness pass, probe and contact sheet in sequence; avoid issuing each as its own shell call.
- **Export at full resolution once,** when the cut is locked. A second full export is warranted only by a fix that alters the picture (a metadata or audio-only fix does not need a new picture render).
- **Correct the ETA early.** When the first frames of a long render have landed, project the end from their measured time per frame and tell the user if it shifted.
