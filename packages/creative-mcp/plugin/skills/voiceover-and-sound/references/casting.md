# Casting a voice

## Which voice already applies

Check before searching, in this order: a voice the user names now → the voice recorded for this production → the project's default voice (both kept as `project_brief` decisions, e.g. "Narrator voice: Adam (ElevenLabs), eleven_multilingual_v2") → nothing.

- A saved voice that no longer resolves (gone from the user's ElevenLabs library, other account) is **stale**: say so plainly ("the saved narrator isn't in this ElevenLabs account") then either get a replacement from them or, if they left casting to you, run auditions. Never fall through silently to a lower level or a default voice. Existing takes stay usable.
- Prose such as "warm, calm female narrator" is a casting brief for the search, never a voice by itself.
- No auditions are needed once a voice is resolved or named, or when the user said "you decide" / go ahead.

## Where voices come from

- `speak_local`: macOS voices (free, offline; see [voices.md](voices.md)).
- `elevenlabs:tts/<voice>`: any voice in the user's ElevenLabs library, by id or (partial) name; their own clones live there too. Display names in other tools' voice lists are not interchangeable — use the name/id this route resolves.
- `openai:gpt-4o-mini-tts` and fal-hosted TTS models (`media_models` query "text to speech").

## Auditions

- Each candidate is a short paid generation of the same line on the production's model, settings and pronunciation rules — save hard-name respellings first. Quote the combined `media_estimate` when it matters; above the user's limit, ask first.
- Submit all candidates, then wait on them together (`jobs_wait` with every id); don't end the turn on pending candidates. Identical requests are reused without paying again.
- Present each option with a one-line character description and its file path (`takes/…`), so the user can play it. Don't ask the user to choose a voice they can't hear. Choosing a voice says nothing about approving the script.
- Only the recorded decision (`project_brief`) casts the voice; a played sample or an answer in chat doesn't. When the user wants the voice for the whole project, record it as the project default.

## A real person's voice (cloning)

Use when the user wants their own voice, or a consenting speaker whose reads came out flat.

1. **Consent first.** Confirm the voice is the user's, or that its owner agreed. No clear yes, no clone — suggest a close library voice. Public figures and anyone who hasn't consented are off limits.
2. **Their account.** Cloning happens in the user's ElevenLabs account and plan (Voice Lab / Instant Voice Clone); there is no clone tool here, so the user creates it. What they need: a single speaker, at least about a minute of clean speech overall without music or other people (pull the audio out of a video first), and a description that records the consent.
3. **Use it** by name with `elevenlabs:tts/<name>`; audio tags (v3) direct the delivery.
4. If ElevenLabs refuses (plan without cloning, library full), tell the user exactly that and offer casting meanwhile. Don't retry on another route.
