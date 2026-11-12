---
name: voiceover-and-sound
description: Create, repair and mix audio for videos and animations — voice-over (offline macOS voices incl. Polish, or ElevenLabs when a key exists) with casting, direction, pronunciation, whole takes and passage repairs; cleaning and levelling a person's own recording; narration cue sheets (one continuous take, word timestamps, pause repair, script-vs-transcript check); sound effects (AI, synthesised, or recorded from free libraries), ambiences, ducking, placing SFX on cuts, mastering to platform loudness and muxing onto picture. Use when the user asks for narration/lektor, a voice, sound design, SFX, cleaning a recording, or "make it sound good" on a render. Music composition/generation: make-music.
---

# Voice-over and sound

Tools: creative MCP `speak_local`, `media_models`, `media_estimate`, `media_generate`, `jobs_wait`, `media_inspect`, `media_review`, `takes_log`, `ffmpeg` (args array, cwd = project), plus Bash. Loudness script: `../edit-video/scripts/loudnorm2pass.sh`; word timestamps + transcript check: `scripts/word_times.py` (paths relative to this SKILL.md's directory). Paid jobs follow [paid generation](../choose-media-model/references/paid-generation.md). Music beds and scores: `make-music`.

Go with the tool the user named, their saved preference, or the project they already have (e.g. an Audacity session). Otherwise: voice and SFX are generated with `media_generate` / `speak_local` or synthesised, and all cleanup, mixing, fitting, loudness and delivery is ffmpeg.

## Finish a recording (a person's own voice)

An existing recording — cleanup, repair, levels, joining or comping takes, delivery — is handled in a single ffmpeg filter chain or script.

- **Quiet recording**: denoise first (`afftdn`, `anlmdn`, `highpass=f=80`, `agate` for gaps), then add gain, and cap the gain so the noise floor is not dragged up; let the voice keep its dynamics instead of pushing it to a loudness number. Check the processed voice stem, not the mix: compare `astats` noise floor and dynamic range of a silent stretch and a speech stretch in the original and the processed file — a floor raised by more than ~15 dB or a collapsed range means back off.
- Available here: `loudnorm`, `ebur128`, `sidechaincompress`, `acompressor`, `alimiter`, `equalizer`, `highpass`, `afftdn`, `anlmdn`, `agate`, `deesser`.

## Generated narration: cast, direct, take, repair

- **Casting** (which voice, auditions, cloning consent): [references/casting.md](references/casting.md).
- **Direction and pronunciation** (model controls, audio tags, pauses, respellings): [references/direction-and-pronunciation.md](references/direction-and-pronunciation.md).
- **Takes, approval, passage repairs, exact pauses, checking a take against the script**: [references/takes-and-repairs.md](references/takes-and-repairs.md).
- Record whole takes, not line-by-line, for narration-led pieces; repair only the passage that's wrong. Before every paid take, `media_estimate` and say who pays; the user's go-ahead for the task covers takes within it — don't add a gate per take unless they asked to approve scripts first (then ask whether to record this script, with the cost stated in the question).
- Narration impossible (no key and the user rejects `speak_local`)? Make the cut work with captions alone (the script lives on screen), mention once that narration needs a voice route, and offer to add it later.

## Workflow

1. **Plan the sound** as a cue list: time → element (VO line, SFX, bed, silence) → level. Write it into `takes/audio-plan.md` when there are more than ~5 cues.
2. **Voice first** — it sets the timing. Choose the mode:
   - **Lines on hits** (trailers, promos, ≤ 6 short lines placed on music hits): one file per line (`vo-01`, `vo-02`…), so a bad line is re-done alone. Measure each with `media_inspect` and lay out cue times from real durations.
   - **Narration-led** (explainers, documentaries, story films; the picture is cut to the voice): write a **cue sheet** with timing targets per beat, record **one continuous take**, measure word timestamps with `scripts/word_times.py`, repair pauses, check script vs transcript, then cut picture to the words. Full method: [references/narration-cue-sheet.md](references/narration-cue-sheet.md).
3. **Pick sources**, cheapest first:
   - Voice: `speak_local` (free, offline) → ElevenLabs/OpenAI TTS via `media_generate` only if `media_models` shows the key under "Configured keys:". Before any paid job tell the user it runs on _their_ key and roughly how much (characters/seconds) you'll generate (`media_estimate`). ElevenLabs: `parameters.voice` takes a voice name from their library or an id; one request takes ≤10 000 characters on multilingual v2 (≤5 000 on v3, ≤40 000 on flash v2.5) — split longer scripts; music 3–600 s; SFX 0.5–30 s (`parameters.loop:true` for seamless loops). Delivered length is checked with ffprobe; a warning means trim/loop or regenerate.
   - SFX/beds: synthesise with ffmpeg (free, instant, exact length) → `elevenlabs:sfx` / `elevenlabs:music` (key) for realistic or melodic material.
4. **Normalise working format:** every element → 48 kHz, stereo (`aresample=48000,aformat=channel_layouts=stereo`). `say` outputs 22.05 kHz mono; ElevenLabs returns MP3.
5. **Mix** in one `filter_complex`: `adelay` to place, `volume` to balance, `sidechaincompress` to duck the bed under the voice, `amix=normalize=0`, `alimiter` as a safety. Render a 24-bit WAV master into `./takes/`.
6. **Master** with the loudness script: −16 LUFS / −1.5 dBTP voice-led, −14 LUFS / −1 dBTP music-led/social. Then mux onto the video (`-map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -ar 48000 -shortest`).
7. **Review with numbers and pictures** — you cannot listen. Check `ebur128` (I, LRA, true peak), `astats` RMS in windows (voice vs bed), `showwavespic` / `showspectrumpic` images (Read them), and that cues land on the intended frames (`media_frames`). Tell the user honestly that the mix was judged by measurements and invite them to listen.

Never overwrite takes: the MCP `ffmpeg` tool forces `-y`; list `./takes` and pick the next `-take-NN`.

## Styling a voice or a mix: one change per revision

- Start with the cheapest preview there is: a free local render where one exists, otherwise just the opening ~5 s of the line.
- Hand each preview over together with the settings it used (voice, model, stability/style or tags, speed, EQ, levels, ducking).
- Per revision change **one** setting, name it ("speed 1.0 → 0.92"), and keep the rest fixed, so the user can tell what made the difference.
- You have no ears here: do not describe the sound or judge it (warm, clear, punchy…). The user plays it and decides.

## Levels that work (before mastering)

| Element                    | Target                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Voice                      | about −18 to −16 LUFS short-term while speaking; highpass 80 Hz |
| Music bed under voice      | 15–20 dB below voice; ducked further 8–12 dB while voice plays  |
| Music bed alone (no voice) | −18 to −14 LUFS                                                 |
| SFX hits                   | peaks 3–6 dB above the bed, never above the voice's peaks       |
| Ambience / room tone       | −40 to −30 LUFS, always on under voice to hide edits            |

## Ducking (verified numbers)

`[vo]asplit=2[vomix][vokey]; [bed][vokey]sidechaincompress=threshold=0.01:ratio=8:attack=20:release=400:level_sc=4[ducked]`. Threshold is _linear_ amplitude (0.01 ≈ −40 dBFS); `level_sc` boosts the key so normal speech drives the compressor hard. Measured on a drone bed under Zosia VO: **~10 dB** reduction while speaking (−27.9 → −37.5 dB RMS), bed untouched before the voice starts and after it ends. The gentler `threshold=0.03:ratio=8` gave only 3–6 dB. Delay (`adelay`) the voice **before** splitting it so key and voice stay aligned. Verify depth by comparing `astats` RMS of the same speaking window with and without the sidechain.

## Voice direction (applies to every TTS)

- Pace: ~150 words/min English, ~130 words/min Polish for explainers; 160–170 for promos. 30 s of narration ≈ 75 EN / 65 PL words. Measured: Zosia at default ≈ 135–155 wpm.
- Write for the ear: short sentences, one idea each, numbers written as spoken ("dwadzieścia procent"), no parentheses or abbreviations.
- Pauses: comma ≈ 0.2 s, full stop ≈ 0.4 s; for deliberate beats use `[[slnc 600]]` (macOS, ms) or split into separate lines and place them with `adelay`.
- Leave 0.3–0.5 s air before the first line and after the last; land key words on visual cuts, not across them.

Details: voices and providers [references/voices.md](references/voices.md); synthesis recipes (wind, drone, sub-boom, whoosh, riser, impact, ticks, room tone) [references/sfx-synthesis.md](references/sfx-synthesis.md); mixing, ducking, mastering and export commands [references/mix-and-master.md](references/mix-and-master.md).

## Sound effects

- Generated: `media_generate {kind:"sfx", model:"elevenlabs:sfx" or fal "fal-ai/elevenlabs/sound-effects/v2"}`, 0.5–30 s, `loop:true` for beds. Prompt the source, action, space and length.
- Simple UI clicks, ticks, tones and abstract hits: synthesise for free ([sfx-synthesis](references/sfx-synthesis.md), or plain Python/numpy).
- A cue pack: name each file and its intended cue time; deliver in the requested format.

## Mix to the destination and deliver

- Mix in the picture's existing editor when there is one (EffectCraft comp, Kdenlive/Resolve project — follow that skill). Otherwise ffmpeg. Match explicit loudness, peak, codec and format requirements of the user or destination over the defaults below.
- Starting a sound late in raw ffmpeg: `adelay=delays=9500:all=1` (ms; `S` suffix = samples; without `all=1` only channel 1 moves). Then verify the decoded duration and the real end of the leading silence (`silencedetect=n=-50dB:d=0.1`).
- Read the result with `media_review FILE` (loudness, true peak, silence). It errors only on peaks above 0 dBTP — check integrated ≈ −14 LUFS (or your target) and true peak ≤ −1 dBTP yourself.
- No editor: mux with ffmpeg, copying the video stream (`-c:v copy`). Narration-led pieces: sound and story timing per the cue sheet.

## Pitfalls

- `amix` without `normalize=0` divides every input's level by the input count — the mix gets quieter as you add tracks.
- `amix duration=` defaults to `longest`; use `duration=first` with a padded voice/bed as the first input to fix the length, or `atrim` explicitly.
- `adelay` needs `all=1` (or one value per channel), else only the first channel is delayed.
- Synth sources (`aevalsrc`, `anoisesrc`) are mono — add `aformat=channel_layouts=stereo` before mixing.
- Clipping in intermediate WAVs is real damage: render 24-bit (`pcm_s24le`) and keep the peaks under −1 dBFS until the master.
