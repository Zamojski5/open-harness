# Motion and timing

## Easing
- Nothing in nature moves linearly. Linear only for: constant mechanical spin, scrolling credits, camera drift that must not "land".
- **Ease-out** (fast start, soft stop) for things entering or reacting — the default for UI and titles. CSS `cubic-bezier(0.16, 1, 0.3, 1)`.
- **Ease-in** (slow start, fast exit) for things leaving. `cubic-bezier(0.7, 0, 0.84, 0)`.
- **Ease-in-out** for moves from A to B that stay on screen. `cubic-bezier(0.65, 0, 0.35, 1)`.
- Overshoot/spring (a 3-8% overshoot and settle) for playful, physical pops; avoid for corporate or serious tone.
- In EffectCraft/AE-style keyframes, set easy-ease and then pull the influence to 60-85% on the landing side for a premium "snap then settle".

## Durations (at 30/25 fps; scale with screen distance travelled)
| Action | Duration |
|---|---|
| Micro UI feedback (hover, press) | 100-150 ms |
| Small element in/out | 200-350 ms |
| Title / logo reveal | 500-900 ms |
| Full-screen transition | 400-700 ms |
| Hold a text card so it can be read | ≥ 1.5 s + 0.3 s per word (≈ 3 words/s reading speed) |
| Logo end card hold | 2-3 s |
Large objects and long distances move slower than small ones. Exits are ~20-30% faster than entrances.

## Stagger and overlap
- Stagger related elements by 40-80 ms (lines of text, list items, letters 15-30 ms). Total stagger under ~600 ms or it drags.
- Overlapping action: secondary parts (hair, cloth, shadow, a subtitle) start and settle a few frames after the main mover.
- Anticipation: 2-4 frames of opposite motion before a big move sells weight.
- Never animate everything at once; one lead motion, the rest supporting.

## Rhythm and cutting
- Cut on action or on the beat. At 120 BPM a beat is 0.5 s (15 frames at 30 fps); cut on every 2nd or 4th beat for calm, every beat for energy.
  Beat length in frames = fps × 60 / BPM.
- Vary shot lengths: a run of 1-2 s cuts, then a longer 3-5 s hold, so the edit breathes.
- Social shorts: hook in the first 1-2 s, a visual change every 2-3 s, final frame readable as a thumbnail.
- J/L cuts (audio leads or trails the picture by 0.5-1 s) make edits feel smooth.

## Frame rates and blur
24 fps cinematic, 25 PAL, 30 web/social, 60 for UI/game capture and smooth screen recordings. Motion blur at 180° shutter (1/(2×fps)) looks natural; turn it on in Blender for fast moves, add it in EffectCraft with the comp motion blur switch.

## Camera moves
Slow push-in (5-10% over the shot) adds tension for free. Ease both ends of every camera move. Handheld noise: small amplitude, low frequency (0.3-1 Hz), more rotation than translation.
