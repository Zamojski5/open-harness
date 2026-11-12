# Prompting still-image and sound models

Video models: [model prompting](../../make-ai-video/references/model-prompting.md). For an option you haven't used, read `media_model_schema` first. Tags carried from our earlier notes: **[doc]** read on the official page, **[snip]** search snippet only, **[exp]** experience.

## Still images

Every family handles exclusions differently; follow its rule below. Shared: one role per reference image, stated in the prompt ("image 1 sets the layout, image 2 is the exact product"); a photo reference gives identity, never the look, once a style is set (`make-ai-video/references/prompting.md`).

### Nano Banana 2.1 / 2 / Pro (Gemini image)

- Versions: `gemini-nano-banana-2.1` / fal `google/nano-banana-2.1` (default), `gemini-3.1-flash-lite-image` (cheapest), `gemini-3-pro-image` (premium), `gemini-2.5-flash-image` (legacy) [doc].
- Write full sentences about the scene, not tag lists [doc]. Exclusions become the wanted state: "a quiet street with every parking space empty", rather than "no cars".
- Edit: name the single element to change and its new form, then say the rest must stay exactly as it is. Compose: say which element comes from which image and where it goes. Refine by follow-up edits instead of restarting [doc].
- 1K/2K/4K (capital K); ratios 1:1, 16:9, 9:16, 4:3, 3:4, 21:9, 3:2, 2:3, 4:5, 5:4; up to 14 references with per-model limits on people and objects [doc]. Strong at text (menus, infographics) [doc]. Output carries SynthID [doc].
- Best for identity-keeping edits, product placement, consistent characters across keyframes. Field note: "exactly the car from the reference photos, no logo or text" kept a real product; a recolour edit ("only the paint changes") kept one car colour across a spot.

### GPT Image 2.5 (Flare, Sunburst)

- No separate exclusion field, so write them into the prompt: render the tagline once, then forbid extra lettering, watermarks and stray logos.
- Edit: "change only X", then list what is preserved. Repeated edits drift, so restate the preserved list every time, and composite back into the original where pixels must not move.
- References: say which image gives which element and that nothing else changes.
- Transparency: ask for an isolated subject, set `background: "transparent"`, output PNG/WebP, and inspect the alpha at hair, glass and shadows. A drawn checkerboard is not transparency.
- `quality` defaults to `high` on fal; use `low` for drafts [doc]. Sizes 1024², 1536×1024, 1024×1536 or custom multiples of 16 between 1:3 and 3:1, longest edge ≤ 3840 [doc]. Masks guide rather than cut exactly [doc]. Weak at precise text placement, recurring characters and brand elements; complex prompts can take ~2 min [doc].

### FLUX.2 (Klein, Pro, Max) and FLUX.3 Klein

- No negative prompts: describe only the wanted state ("crisp focus from front to back") [doc].
- Subject + action + style + context, most important first; 30–80 words is the sweet spot (10–30 for quick ideas, 80+ for dense scenes) [doc].
- Bind hex colours to objects ("the mug in #1E6F5C") [doc]. JSON prompts work (scene, subjects, style, color_palette, lighting, mood, background, composition, camera) [doc]. Quoted text with placement, font, size and colour [doc].
- Multi-reference: say what each image contributes ("the oak grain from image 3 for the tabletop"). Pro takes up to 8 refs, flex 10; up to 4 MP in multiples of 16, ≤ 2 MP recommended [doc].

### Seedream 5 Pro

- On-image text in double quotes. Keep prompts under about 600 English words; longer loses detail.
- Several images: state each one's contribution; fal labels them "Figure 1" in its examples while ByteDance writes "Image 1". Past 10 inputs, only the final 10 are used, without warning. Strong at posters and Asian/Latin typography [exp].

### Ideogram 4

Its training captions were JSON, so a plain-language prompt only works with expansion switched on (`expansion_model` Medium or Large). If you set expansion to `None`, supply the caption yourself as `high_level_description`, `style_description` (lighting, medium, a palette of at most 16 hex values) and `compositional_deconstruction` (the background, then each element, giving any text element its literal `text`).

### Recraft V4

When asking for a vector or a logo, state what kind of graphic it is, the shape logic, a strict palette and the stroke rule, and ask for flat fills with no gradients, shadows or texture.

## Voices

### ElevenLabs v4, v4 Turbo and v3

Narration craft lives in `voiceover-and-sound`; these are the model's rules.

- A bracket tag holds until the next one; add one where delivery changes, at most one per clause, with nuance combined in one bracket (`[hushed, amused]`).
- Write tags as voice qualities. v4 also produces sound effects, so `[thunder]` may be heard as thunder; prefer `[rough, low voice]` over noun-like tags.
- Ellipses add a pause and weight, capitals add stress. No SSML: `<break>` is ignored on v4 and v3.
- Tags work when the voice can already do that delivery; a soft narrator won't shout convincingly.
- Narrated emotion ("he said angrily") is read aloud; use a tag instead.
- v4 reads other languages fluently without the voice's native accent; accent tags are experimental.

### MiniMax Speech 2.8 HD / Turbo

- A pause is written `<#1.5#>` (0.01–99.99 s); place it between two words and don't stack two of them.
- Non-verbal sounds go in round brackets: `(laughs)`, `(sighs)`, `(breath)`, `(gasps)`, `(sniffs)`, `(coughs)`, `(groans)` and others. fal spells `(clears throat)`, MiniMax `(clear-throat)`: test first.
- Voice controls sit in `voice_setting` (`voice_id`, `pitch`, `emotion`, and `speed` from 0.5 to 2); pick the language with `language_boost`. fal returns hex unless you ask for `output_format: "url"`.

## Music

Cue timing is never exact; fit it in the edit (profile with ffmpeg `ebur128` and pick the window).

### Eleven Music

- Engineering terms change the actual sound (sidechained, close-mic'd, bone-dry, tape saturation, plate reverb). Tempo is kept to the BPM; the key is kept most of the time.
- Describe the arrangement step by step, in order with words like "open with", "only", "then", "add". Without "only", the model fills gaps.
- A loop is mostly exclusions: bars, BPM, key and what must not appear ("drums only, no melody").
- It sings unless told not to: `instrumental: true` guarantees no vocals. For a song, place the vocals in time ("vocals enter at 0:20", "instrumental from 1:30 to the end").
- Length 3–600 s; billed $0.15 per minute by the second, so a sting is cheap.

### Lyria 3.5 and Lyria 3

- On fal the only inputs are `prompt` plus an optional `image_url` for mood, so duration, form and anything to leave out must be written in the prompt. Lyria 3 clips are fixed at 30 s; with 3.5, ask for the running time in words ("a 90-second piece").
- Structure as `[Intro] -> [Verse] -> [Chorus]` or time ranges (`[0:00-0:20] Intro: …`, "the drop lands at 0:24").
- Put your own words after `Lyrics:` with section tags, and backing vocals in parentheses. It sings unless you ask for "Instrumental only".
- Requests to imitate a named singer or to use protected lyrics get rejected. Field note: 3.5 returned 62 s for a 16 s request.

### MiniMax Music 3 (`minimax/music-3`)

- Write `prompt` as a layered description: the song as a whole (genre, BPM, key, how the emotion moves, production), the singing (gender, timbre, harmonies), then the band per section (instruments, groove, sense of space).
- `lyrics` cannot be empty. Section tags `[intro] [verse] [pre-chorus] [chorus] [post-chorus] [bridge] [instrumental] [solo] [outro]` need a line to themselves; words placed after a tag on its line are lost.
- `duration` (1–300 s) only caps the result, so write lyrics that fit and check the delivered length.

### Stable Audio 2.5

Leave `seconds_total` unset and you get 190 s, so set it every time.

## Sound effects: ElevenLabs SFX v2

- One sound per prompt; a short ordered sequence is fine ("boots on gravel, then a car door slams"). Layer longer scenes in the mix.
- Terms it responds to: impact, whoosh, ambience, one-shot, loop, braam, glitch, drone; musical hits can also take a tempo and key.
- Length: `duration` 0.5–30 s (22 s on fal's copy) or unset to let it choose; `loop: true` for beds.
- `prompt_influence` (default 0.3): raise for a precise hit, keep low for varied takes.
- Output is usually MP3 (48 kHz WAV only for non-looping effects): inspect and convert to 48 kHz WAV before mixing.
