# Voices and providers

## Offline: macOS `say` (`speak_local`)

`speak_local { text, voice?, title? }` → `./takes/<title>-<id>.m4a` (AAC, 22.05 kHz mono — resample to 48 kHz stereo before mixing).

- **List voices:** `say -v '?'` (Bash). On this machine the only Polish voice is **Zosia (pl_PL)**, compact quality; no Enhanced/Premium/Siri voices are installed. Users can add better ones in System Settings → Accessibility → Spoken Content → System voice → Manage Voices (look for "(Enhanced)"/"(Premium)" variants, e.g. Zosia Enhanced). Re-run `say -v '?'` after they download, and use the exact name shown (e.g. `-v "Zosia (Enhanced)"`).
- English: Samantha (en_US), Daniel (en_GB), Karen (en_AU), Moira (en_IE) are usually present; avoid novelty voices (Bahh, Bells, Boing…).
- **Inline commands** work inside `speak_local` text (the tool has no rate parameter):
  - `[[rate 160]]` — words/min. Coarse on compact voices: measured on an 18-word Polish line, rate 100 → 9.5 s, 140 → 8.7 s, 160/175/default → 7.9 s, 200 → 7.0 s. Always check the resulting duration.
  - `[[slnc 600]]` — insert 600 ms of silence (measured: `[[slnc 1500]]` added ~1.47 s).
  - `[[emph +]] word [[emph -]]` — emphasis (subtle).
- For fine tempo use `atempo` on the file (0.9–1.1 sounds natural): `ffmpeg -i vo.m4a -af atempo=0.95 …`.
- Direct to 48 kHz WAV via Bash (better than the tool's AAC): `say -v Zosia --file-format=WAVE --data-format=LEI24@48000 -o takes/vo-01.wav "Tekst."` (verified: pcm_s24le 48000).
- Trim leading/trailing silence:
  `ffmpeg -i vo.aiff -af "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,aresample=48000" -c:a pcm_s24le takes/vo-01-trim.wav`

Quality expectation: `say` voices are clear but robotic. Fine for drafts, timing, internal videos; for client-facing narration suggest an Enhanced voice or ElevenLabs.

## ElevenLabs (paid, user's key)

1. `media_models` → look at "Configured keys:". No `elevenlabs` → don't attempt; offer `speak_local`, or ask the user for a key (stored with `media_set_key`).
2. Say who pays before the job: "This uses your ElevenLabs key; ~N characters of TTS / ~N s of music."
3. Calls (outputs land in `./takes/` as MP3):
   - Speech: `media_generate { kind: "speech", model: "elevenlabs:tts/<voiceId>", prompt: "<text>", title: "vo-01" }`. Without a voiceId it uses a default English-leaning voice; model is `eleven_multilingual_v2` (handles Polish). Extra native fields (e.g. `voice_settings: {stability: 0.5, similarity_boost: 0.75, style: 0.2}`) go in `input`.
   - SFX: `media_generate { kind: "sfx", model: "elevenlabs:sfx", prompt: "deep cinematic impact with long tail", parameters: { duration: 3 } }`.
   - Music: `media_generate { kind: "music", model: "elevenlabs:music", prompt: "calm ambient piano bed, 80 bpm, no vocals", parameters: { duration: 30 } }`.
4. Long jobs return a job id → `jobs_wait`. Identical requests are reused; pass `fresh: true` for a new take.
5. Prompting SFX/music: name the source, action, space and length ("wooden door creaks open slowly in a small room"); for beds state tempo, instrumentation, mood, "no vocals", and that it should loop or end cleanly.

Other paid TTS: `openai:gpt-4o-mini-tts` (needs openai key). fal.ai hosts more audio models — search with `media_models query="text-to-speech"` / `"music"`.

## Retakes

- One file per line: `vo-01`, `vo-02`… Change only the line that's wrong (wording, stress, pace), regenerate, re-measure its duration, and shift later cues if it changed.
- If a word is mispronounced, respell it phonetically in the prompt ("Open Herness" → "Ołpen Herness" for Zosia) or split it with a comma.
- Keep a list of line → file → duration → start time in `takes/audio-plan.md`.
