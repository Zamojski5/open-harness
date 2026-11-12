# Takes, approval and repairs

## Every paid call

- Carries a `request_id` you choose (e.g. `vo-main-t3`). Sending it again with that id and unchanged parameters gives back the original job instead of a second charge — use it after a timeout or unclear failure. A new take needs a new id.
- Is estimated and its payer named (`media_estimate`), per `choose-media-model` paid generation.

## Recording a take

- One take = the whole script, or one speaker's part (a range spanning two speakers is generated as separate takes). Over the model's character limit: split at paragraph breaks, same voice and seed, and join at the pauses.
- Wait with `jobs_wait` (repeat while pending) and don't end the turn on a take you still need. A failed job has nothing to use — read its category and hint. An `uncertain` one may have reached the provider: check with `jobs_status {collect: true}` before offering a new take with a new id; never blindly resubmit.
- Log each take with `takes_log add`, noting: kind (`full`, `passage` repair, `assembled`, `edited` pause, `audition`), the script version it was made from, voice, model and delivery/tags used (name these when two takes of one script differ), and measured loudness (`ebur128` I / TP).
- A take made from an older script is **stale**; one whose words are affected by a changed pronunciation rule is flagged too. Say so before using either.

## Approving

- The chosen take is `takes_log pick`. Build captions and the edit only from the picked take, using its audio file and its word timings. Picking a stale take needs the user's explicit OK ("its words are older than the script").
- When the user prefers another take: pick it, move the cuts that follow narration onto that take's word timings, and re-render — no new voice generation.

## Repairs (re-record only what is wrong)

1. **Plan (free).** Decide the scope: a **passage** (a misread word, "more energy on the reveal") or the **whole take** (new voice, new read style or tone throughout). The passage boundary is the words between the silences around the change — find them in the take's word timings.
2. **Record the passage** with the production's voice and settings plus the instruction, new `request_id`. Check it (below).
3. **Assemble (local, free):** cut the parent take at those silences and splice the passage in (`atrim` + `concat`, 8 ms fades at the joins, room tone under the seams). The result is a new `assembled` take; the parent stays untouched.

Limits: a repair only makes sense on a take of the current script (script changed → record a fresh full take), and splicing needs word timings around the replaced words (none → offer a full take).

## Exact pauses

Make the silence between two words exactly N ms (50–10,000): find the gap in the word timings, cut or pad silence in the middle of it (`atrim` + `apad`/`anullsrc` + `concat`), keeping ~0.15 s of natural air next to the speech. It is a local, free edit; the result is an `edited` take with shifted word timings (re-run `word_times.py` or offset the later words) and needs its own approval.

## Check every finished take against the script

Provider audio has no independent proof it said the script. Transcribe and diff: `python3 ../scripts/word_times.py TAKE --lang en --script script.txt`. Read the `diff`:

- Compare words lowercase, without punctuation. Integers 0–999 equal their spoken form ("40" = "forty", "a hundred and five" = "hundred five"); decimals, times, fractions and percentages (3.5, 1:30, 24/7, 40%) don't — when the transcriber writes those as words, or spells a name differently, treat that line as matching once you've confirmed it by its timing.
- Real misses (dropped, added or wrong words) → passage repair. Then check again.
- Tell the user what inspection you actually did (transcription diff, measurements) — you cannot listen.

## Converting a performance (speech-to-speech)

"Read it like me": the cast voice performs the user's recorded read — keeping their pacing and inflection while replacing who they sound like. Not available through `media_generate` here; if a fal speech-to-speech model appears in `media_models`, the rules are: 1 s–5 min of trimmed audio (≤50 MiB, longer reads split at pauses), billed per second, no tags or pronunciation rules (the performance decides), and the result has no word timings until transcribed.
