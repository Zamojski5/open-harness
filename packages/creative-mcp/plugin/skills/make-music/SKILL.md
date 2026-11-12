---
name: make-music
description: Generate or revise music — beds and scores for a video timed to its reveals, songs with vocals, lyric timings, measured comparison of a track against references, and MIDI parts for Logic Pro. Use when the user asks for music, a soundtrack, a score, a jingle or a bed, wants a track changed, or wants a mix compared with a reference. Mixing it with voice and SFX and delivery: voiceover-and-sound.
---

# Make music

You cannot hear. The user judges by ear; you report measurements and say what you could not check.

Tools: `media_models`, `media_estimate`, `media_generate {kind:"music"}`, `jobs_wait`, `media_inspect`, `media_review`, `takes_log`, ffmpeg. Paid jobs follow [paid generation](../choose-media-model/references/paid-generation.md).

## Route

- When the user names a tool, site or model (Suno on their account, a DAW project they have), use it and its billing; the rules below still apply.
- Otherwise generate: `elevenlabs:music` (3–600 s, their ElevenLabs plan) or the fal music default (`media_models` shows it, e.g. Lyria). Switch models only if the user asks for one by name or the default can't deliver what's needed (a particular vocal style, stems).
- No local composition engine or sample library is available here. Work in the user's DAW through its skill (`ableton-live`, `reaper`); for Logic, write MIDI (notes below).
- Revisions ("punchier", "darker", "slower", "longer intro"): regenerate with the changed prompt and keep every version (`<name>-take-NN.wav`, `takes_log` with what changed). Changing one element (drums too busy, vocal too loud) of a generated track is a stem job, not a regeneration: separate it into vocals/drums/bass/other with a fal stem-separation model when `media_models` lists one (estimate first), edit those, remix.

## Generate

1. Quote first: `media_estimate` with the request and `count`; tell the user the price and who pays.
2. Request: `media_generate {kind:"music", model:"elevenlabs:music", prompt:"…", parameters:{duration:30}}`. A video's bed is instrumental and as long as the picture. Prompt: genre, tempo (BPM), instrumentation, mood, structure, "no vocals" for beds, how it ends.
3. Never ask for a particular existing song's melody or hook.
4. A bed the user asked for and that fails on billing is a billing problem to raise (which key/plan is empty, cheaper option). If the bed was your own default idea, a billing failure doesn't hold up the piece — finish without music and mention it in one line.

## Score a video

- Put the picture's key moments into the prompt as structure ("sparse intro, opens up at 0:12, ends on a clean button at 0:30").
- Generated timing is approximate. Measure the real length (`media_inspect`) and the hit positions (onsets: `python3 ../make-motion-graphics/scripts/beat_grid.py bed.wav`), then move, cut and fade the bed until its hit sits on the reveal and its ending coincides with the final frame. Trim on a bar (4/4 bar = 240 / BPM s) and fade the last 1–2 s.
- With narration: duck the music under it (voiceover-and-sound sidechain numbers).
- Picture cut **to** a supplied track (lyric video, montage) is the reverse job: `make-motion-graphics` music sync.

## Lyric timings

`python3 ../voiceover-and-sound/scripts/word_times.py song.wav --lang <code> --model large-v3` (a whisper engine, not `--engine silence`). Speech detection can drop sung words; compare every line with the supplied lyrics and fix by hand where the transcriber invented words over instrumental parts.

## Compare a track with references

Report numbers, not a verdict on taste: integrated loudness, loudness range and true peak (`ebur128=peak=true`), tempo and beat strength (`beat_grid.py`), and spectral balance as side-by-side images (`showspectrumpic=s=800x300:scale=log:fscale=log` for each file, read them together). For a revision, run the same measurements on the old and new take and list what changed.

## Logic Pro (MIDI hand-off)

Logic has no scripting API; write parts as `.mid` files.

- New project: `open -a "Logic Pro" part.mid` opens it without a file dialog.
- Into an open project: File > Import > MIDI File, then Cmd+Shift+G and type the path. Avoid the browser's All Files tab; it can hang Logic.
- Put a program change on each melodic channel, otherwise Logic won't assign a software instrument. Drums on channel 10 arrive on an External MIDI track that makes no sound — drag the region to a software-instrument track loaded with a kit.
- Before bouncing: metronome off (Logic bounces the click), format WAVE, range set to the music.
- Menu work in Logic needs the user (no desktop control here): give them the exact steps.

## Deliver

Mix with voice and SFX, master and mux: `voiceover-and-sound`. Credit any third-party music (`craft` rights-and-sources, CREDITS file).
