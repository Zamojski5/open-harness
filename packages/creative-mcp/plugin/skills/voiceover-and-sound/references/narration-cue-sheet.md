# Narration cue sheets

For narration-led pieces (explainers, documentaries, story films), where the voice carries the edit and the picture is cut to it.

## 1. Write the script as a cue sheet

`takes/vo-cues.md`, one row per beat:

| Beat | Target start | Target dur | Text | Picture | Measured start | Measured end | Δ | Action |
|---|---|---|---|---|---|---|---|---|
| B1 | 0.5 | 4.0 | Latarnia stoi na skale od stu lat. | S01 wide | | | | |
| B2 | 5.5 | 4.5 | Każdej nocy zapala ją ta sama kobieta. | S02 match | | | | |

- Target duration from word count: PL ≈ 2.2 words/s, EN ≈ 2.5 words/s (130/150 wpm). A beat that doesn't fit its target gets rewritten now, not squeezed later.
- Mark the **sync word** in each beat (the word a cut or visual hit must land on) in bold.
- Plan pauses: between beats 0.4–0.8 s; before a reveal 1.0–1.5 s.

## 2. Record one continuous take

Record the whole script as one file: intonation, pace and breath stay consistent, which per-line files never quite match. With `say`/`speak_local`, put planned pauses into the text (`[[slnc 700]]`). With paid TTS, generate in one request when the length limit allows; otherwise split at paragraph breaks, never mid-beat. Keep per-line recording for trailers and other lines-on-hits work (see the SKILL.md workflow).

## 3. Measure word timestamps

```bash
python3 <skill>/scripts/word_times.py takes/vo-take-01.wav --lang pl --script takes/vo-script.txt
```
- Engines are tried in order: `faster-whisper` (Python package; `large-v3` weights cached in `~/.cache/huggingface`), `mlx_whisper` (CLI, Apple Silicon), then ffmpeg `silencedetect` (speech segments and pauses only, no words). Measured here: 6 s of Zosia took about 13 s on CPU with faster-whisper large-v3.
- Not installed? Offer the user `pip install faster-whisper` (about 3 GB of weights on first use). Without it, the silence engine still gives beat boundaries if each beat is separated by ≥ 0.3 s of silence.
- Whisper word *ends* run about 0.1–0.3 s early or late. For precise cut points, take the edge from `--engine silence` near the whisper time.
- Output: `<take>.words.json` with `words`, `pauses` and `diff`. Fill the "Measured" columns from it.

## 4. Repair pauses

- Pause too long (> planned + 0.3 s): cut silence in the middle of the gap, not at its edges, and keep 0.15 s either side of speech. `atrim` both parts and `concat`, or `silenceremove` for a global trim.
- Pause too short before a reveal: insert silence (`apad`, or split and `adelay`).
- Fill every edit with room tone under the voice (−40…−30 LUFS), so cuts don't drop to digital silence.
- Re-measure after repairs; timestamps shift.

## 5. Script vs transcript

`diff` lists `replace`, `delete` and `insert` against the script. Then:
- Real errors (missing word, wrong word, mispronounced name): re-record that sentence only, matching the pace, then splice at pauses. Or re-generate the whole take if the voice is synthetic and cheap.
- False positives: numbers ("stu" vs "100"), clitics and word joins ("zapala ją" vs "zapalają"), punctuation, capitalisation. Listen-check by measurement (the duration is plausible), then ignore them.
- Accept the take when every real diff is resolved. `word_accuracy` ≥ 0.9 is typical once number and word-join false positives are discounted.

## 6. Sync picture to words

- Cut on the measured start of the sync word, or 2–4 frames before it (the picture should lead the word slightly).
- J-cut: the next beat's voice starts 6–12 frames before its picture. L-cut: the voice tails over the next shot.
- Captions come from the same `words` array (group into 32-character lines, `edit-video` subtitles reference).
- Write the final timings back into the cue sheet and `06-edit.md` (`make-film`).
