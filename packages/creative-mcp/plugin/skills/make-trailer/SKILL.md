---
name: make-trailer
description: Make a cinematic trailer or teaser (15-90 s) from Blender plates, AI video shots, EffectCraft titles, sound design and voice-over - beat structure, shot list, cut rhythm, title cards, sound hits, risers, mix and delivery. Use when the user asks for a trailer, teaser, sizzle, promo, cinematic reveal or launch video, or wants several shots cut together with music and titles.
---

# Make a trailer

A trailer is a rhythm machine: sound structure first, pictures cut to it, titles as punctuation. Use `production-pipeline` for big jobs (director/builder/auditor) and `quality-loop` for every element. Tools: Blender (`blender` skill) or AI video (`make-ai-video`) for shots, EffectCraft (`effectcraft`, `make-motion-graphics`) for titles and finishing, ffmpeg (`edit-video`) for the cut and exports, `voiceover-and-sound` for VO, music bed and SFX.

## 1. Brief and length

| Format | Length | Shots | Title cards |
|---|---|---|---|
| Social teaser | 15–20 s | 6–10 | 1–2 + logo |
| Teaser | 30–45 s | 12–20 | 2–3 + logo + date/CTA |
| Trailer | 60–90 s | 25–45 | 3–5 + logo + CTA |

Agree on: logline (one sentence), tone (epic / mystery / emotional / action / comedic), the money shot, end card (title, date, URL), language of VO and titles, aspect (16:9 master; 9:16 cut-down later), and whether paid AI generation is allowed (who pays).

## 2. Beat structure (three acts compressed)

Write a **beat sheet** with timecodes before making anything (`takes/<name>-beats.md`):

1. **Cold open / hook (0–10 %)**: one striking image or sound; silence or a single drone. Hook in the first 2 s for social.
2. **World / setup (10–35 %)**: establishing wides, slow cuts (2–4 s), VO line 1, first title card ("THIS AUTUMN"-type).
3. **Turn (≈35 %)**: a hit — impact + black, or a music drop. Something changes.
4. **Escalation (35–80 %)**: cuts accelerate (2 s → 1 s → 0.5 s), riser underneath, title cards between bursts, VO lines 2–3.
5. **Climax / money shot (80–90 %)**: biggest image, music peak, then a hard cut to black/silence.
6. **Button + title (90–100 %)**: beat of silence, a final line or sting, logo reveal, end card held ≥ 2.5 s.

## 3. Shot list

For each beat: shot id, duration (frames), framing (wide/medium/close/insert), camera move (push-in, track, orbit, static), subject action, light/mood, source (Blender / AI / stock / title), sound cue. Shoot ~30 % more shots than needed. Rules:
- Vary scale between neighbours (wide → close → medium); never cut between two near-identical framings.
- Continuity of screen direction; match the motion direction across cuts.
- Every shot has motion (camera or subject); a static shot gets a slow 3–5 % push-in in EffectCraft.
- Render plates at the delivery fps (24 for cinematic). Blender: PNG/EXR sequences, consistent colour management (AgX/Filmic), a few frames of handles at each end.

## 4. Sound first (temp then final)

1. **Music bed**: pick/generate a cue with the act structure (intro pad, build, drop, climax, stop). Note its BPM and hit points. AI music via `media_generate` (`kind: music`) only with a key and the user's OK on cost; otherwise synthesize a drone/riser bed (voiceover-and-sound recipes).
2. **Hit map**: list timecodes for impacts, booms, whooshes, risers, reverses, silence. Cuts land on hits; title cards land on hits; the logo lands on the last hit.
3. **VO**: 3–6 short lines total, recorded line by line (speak_local voice `Zosia` for Polish drafts, ElevenLabs when available). Leave 0.3–0.8 s air around each line.
4. **Sound design** per shot: whoosh into fast cuts (starts 8–12 frames before the cut), sub boom on title hits, riser 2–6 s before the climax, reverse cymbal/whoosh into the drop, 0.5–1 s silence before the button.

## 5. Cut rhythm rules

- Cut on the beat or exactly 1–2 frames before it (feels tighter). At 120 BPM a beat = 12 frames at 24 fps.
- Opening shots 2–4 s; escalation 0.5–1.5 s; flash frames (2–4 frames) and black frames (4–12) for punctuation.
- Use J-cuts/L-cuts for VO: sound leads picture by 6–12 frames.
- Dip to black between acts (6–12 frames), not crossfades. Crossfades only for dreamy/emotional tone.
- Speed ramps (fast → slow) on action peaks; slow-motion needs a source rendered at a higher frame rate or AI-generated slow motion.
- Leave the strongest image for the climax; don't reveal it in the first half.

## 6. Titles and finishing (EffectCraft)

- Unifying finish over all shots: one grading adjustment layer (Lumetri look + Curves), film look (grain 0.4–0.7, vignette, slight aberration), optional 2.39:1 letterbox — keep titles inside the letterbox.
- Flashes: white solid, Add, 2–3 frame opacity spike on impacts; lightning-style double flash for drama.
- End card: logo animation (1.5–2 s), title, date/URL; hold ≥ 2.5 s with the music tail.

Assemble either in EffectCraft (import shots as footage, one comp, layers sequenced with `layer.timing`) or with ffmpeg concat (`edit-video`) and then overlay titles rendered with alpha. EffectCraft is better when grade/titles span cuts; ffmpeg is faster for many plain cuts.

## 7. Mix and master

- Stems: dialogue/VO, music, SFX. Duck music 6–10 dB under VO (sidechain recipe in voiceover-and-sound).
- Loudness: −14 LUFS integrated, true peak ≤ −1 dBTP for web/social; −23 LUFS for broadcast (EBU R128). Normalize with two-pass loudnorm (edit-video).
- Check: no clipping, no silence gaps except intended, VO intelligible on laptop speakers.

## 8. Review and deliver

- Rough cut with temp sound first; review with `media_frames` (24–36 frames) and play the audio; score against the beat sheet.
- Iterate on rhythm before polishing shots. Max 3–4 rounds; never overwrite takes (`trailer-v01.mp4`, `-v02`…).
- Deliver: 16:9 master (H.264 1080p 20 Mbps, AAC 320k, −14 LUFS), 9:16 and 1:1 cut-downs (reframe, re-place titles in safe areas), ProRes master on request, a poster frame PNG.
- Present honestly: which shots are placeholders, what would improve with more render time or paid generation.
