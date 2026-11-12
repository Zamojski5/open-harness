# Join grammar: CUT or CONTINUE

Every boundary between two consecutive shots in `03-shot-list.md` gets exactly one label and a reason:

```
S03 → S04: CUT (reaction — we see her face after the letter)
S04 → S05: CONTINUE (she keeps walking to the door; carry: tail-reference)
```

## CUT — needs a story reason

A cut is a decision. Valid reasons:

| Reason | Example |
|---|---|
| **Time jump** | night → morning; skip the boring part of a journey |
| **Place change** | interior → exterior, new location |
| **New information** | insert of the letter, the clock, the hidden knife |
| **Reaction** | cut to the person who hears/sees the thing |
| **Point of view** | what the character sees |
| **Emphasis / scale change** | wide → close-up on the decisive moment |
| **Rhythm** | music beat, montage, accelerating cuts in a build |

If none applies, it is not a cut — it is a CONTINUE (or the two shots should be one).

Cut craft: change scale or angle by ≥ 30° (avoid jump cuts between near-identical framings); keep screen direction (180° rule); cut on action (in the middle of a movement, both halves carry it); match the eyeline in reactions.

## CONTINUE — the same action carried on

The action, camera move and moment continue across the boundary. Reasons the boundary exists at all: the generator/render can't do the whole length, or a camera angle changes mid-action without a story beat. **A model's maximum clip length never decides where a shot ends** — split long actions at a natural pause or mid-motion and carry the motion.

### Carry-motion ladder (strongest first — use the highest rung your tools support)

1. **Extend the same generation** — the model's native extend/continue feature (continues from its own latent state; best motion and identity continuity). Check `media_model_schema` for extend/continue endpoints.
2. **Tail of the previous clip as a video reference** — pass the last 1–2 s of clip A as video input/reference for clip B (models with video-to-video or video reference inputs).
3. **One continuous previs across the run** — render the whole run as one Blender/grey-box animation, split it, and drive each generated segment from its part (video-to-video / depth or pose control). Motion is decided once, so segments line up.
4. **Generate the run as one clip** — if the whole run fits within one model's max duration, generate it in one go and cut it in the edit instead of joining.
5. **Small overlap + cross-dissolve** — generate both segments with 0.5–1 s of the same action overlapping, then dissolve 6–12 frames in the overlap. Hides small mismatches; not for fast motion.
6. **First + last frame conditioning** — clip B starts on A's last frame and ends on a planned keyframe. Position matches; velocity may jump.
7. **Last frame only** — clip B starts on A's last frame. Position matches at the join; speed, direction and lighting often reset. Weakest — use only for slow or static moments.

Extract the last frame exactly: `ffmpeg -sseof -0.1 -i A.mp4 -frames:v 1 -update 1 A-last.png` (check it isn't a blurred or warm-down frame; if so trim A first and take the frame at the new end).

### Checking a CONTINUE join

- `media_frames` across the join (last 0.5 s of A + first 0.5 s of B, ~12 frames): position, direction and speed of subject and camera, light, palette, identity.
- A visible velocity jump → go up the ladder, or convert the boundary to a CUT with a reason (cut on action to a different angle).
- Log the rung used in `05-generation.md` so retakes keep the same method.

## For 3D (Blender) shots

CONTINUE is trivial: render one animation and split frames. CUT between 3D shots: separate cameras on markers (`blender` skill camera rig), same scene, so lighting and continuity hold automatically.
