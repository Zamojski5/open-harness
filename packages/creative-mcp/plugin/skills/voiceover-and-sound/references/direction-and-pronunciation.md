# Directing the read and pronunciation

The model's own documentation is the authority on what it accepts; check `media_model_schema` (fal) or the ElevenLabs model page before relying on a control. ElevenLabs model is chosen with `input.model_id` (default `eleven_multilingual_v2`).

## Character limits

Per request: `eleven_v3` 5,000, `eleven_multilingual_v2` 10,000, `eleven_flash_v2_5`/`eleven_turbo_v2_5` 40,000. The limit counts the text the model receives — audio tags and respelled names included — so a script that fits as written may overflow once they're added. Split at paragraph breaks (same voice, same seed), never mid-beat.

## Delivery style

Decide one of three reads before tweaking numbers:

| Read              | For                                     | Watch out                     |
| ----------------- | --------------------------------------- | ----------------------------- |
| Natural (default) | someone explaining to a friend          | —                             |
| More expressive   | ads, characters, varied emotive reads   | less consistent between takes |
| Steady            | how-tos, legal text, long uniform reads | risks sounding flat           |

Then set explicit controls (`input.voice_settings`), only the ones the model lists:

| Control                    | v3                                | Multilingual v2 | Flash v2.5 | Speech-to-speech |
| -------------------------- | --------------------------------- | --------------- | ---------- | ---------------- |
| `stability`                | `creative` / `natural` / `robust` | 0–1             | 0–1        | 0–1              |
| `similarity_boost`         | –                                 | 0–1             | 0–1        | 0–1              |
| `style`                    | –                                 | 0–1             | –          | 0–1              |
| `use_speaker_boost`        | –                                 | yes             | –          | yes              |
| `speed`                    | –                                 | 0.7–1.2         | 0.7–1.2    | –                |
| `language_code`            | yes                               | –               | yes        | –                |
| `apply_text_normalization` | auto/on/off                       | auto/on/off     | auto/off   | –                |
| `seed`                     | integer                           | integer         | integer    | integer          |

(Eleven v4 / v4 Turbo, where available: `stability`, `similarity_boost` 0–1, `language_code`, text normalisation, `seed`.) Report any control you could not apply.

## Audio tags (v3; v4 family)

Square-bracketed words the model performs instead of reading: `[warmly]`, `[excited]`, `[whispers]`, `[laughs]`, `[short pause]`. One at the very start sets the opening tone; one before a span directs that span. On v4 a tag may be a short plain-language direction and several can share a bracket (`[lower, thoughtful]`, up to ~60 characters). Tags count towards the character limit. Other models read tags aloud — don't use them there. Your delivery brief and notes are never sent to the model.

## Pauses

- An **exact** pause is an edit on the finished take (silence between two words set to N ms, 50–10,000) — see [takes-and-repairs.md](takes-and-repairs.md#exact-pauses). Don't try to get exact lengths from the model.
- v3 understands `[short pause]` / `[long pause]`. SSML `<break>` is ignored by v4; never put markup in the script. `speak_local` takes `[[slnc 600]]`.

## Pronunciation rules

Keep rules out of the script. Store them in `takes/lexicon.json` and apply them only to the text sent to the TTS; the script, captions and on-screen text keep the written spelling.

| Field        | Rule                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `phrase`     | the written word or phrase, whole words, 1–100 characters, no brackets/slashes/braces, tabs or line breaks            |
| `respelling` | required; a sound-alike anyone can read, stressed syllable in capitals, syllables hyphenated: `MOH-duh`, `kwin-OH-uh` |
| `ipa`        | optional, no slashes, IPA symbols only (no X-SAMPA/ARPAbet); used by v3, ignored elsewhere                            |
| `locale`     | the language it applies to (default: the narration language); none = all languages                                    |
| `matching`   | case-insensitive by default; case-sensitive to tell "US" from "us"                                                    |

Write the respelling first — it works on every model; IPA is an extra for cases where the respelling could be read two ways and you're sure of the transcription. Scopes: this production (a character name), the project (client brand and product names), shared across projects (ask first — it affects others' work). When rules collide: a rule for another locale is skipped; for the same phrase the narrower scope wins; in the text the longest match wins ("Open Herness Studio" before "Open Herness").

After a rule changes, existing takes don't change. Note which takes contain the phrase and regenerate that passage or the whole take ([takes-and-repairs.md](takes-and-repairs.md)).
