---
name: present-results
description: How to hand finished creative work to the user - show the final file and a contact sheet, summarize what was done, state honestly what still differs from the references, offer next options, keep earlier takes. Use whenever you finish a render, edit, image or audio piece, or end a work session with something to show.
---

# Present results

The hand-off is part of the work. A strong result presented vaguely reads as weak; a flawed result presented honestly earns trust.

## Before you present

- `media_review` is clean (no errors; warnings fixed or explained).
- The final take is logged and picked: `takes_log add` + `takes_log pick`.
- You looked at the final yourself one last time.

## What to show (in this order)

1. **The result.** The final file path (relative to the project, e.g. `takes/launch-teaser-take-04.mp4`). Show it: for an image, the image itself; for video, a contact sheet (`media_frames`, 8-12 frames) or the `media_review` sheet if clean; for comparisons between finalists, `takes_compare`.
2. **One-line summary** of what it is: "15 s vertical teaser, 1080x1920, -14 LUFS, voice + music."
3. **What you did** — 3-5 bullets of meaningful decisions (not every tool call): the look, the structure, notable fixes from review rounds.
4. **What still differs from the references or brief** — be specific and honest: "Fog is thinner than in ref 3", "Logo reveal is 0.5 s faster than asked to keep under 15 s", "Voice is synthetic (no ElevenLabs key)". If nothing material differs, say so plainly. Never claim it matches when you didn't check.
5. **Next options** — 2-3 concrete choices the user can pick with one word: "A) warmer grade, B) a 6 s cut-down, C) add captions". Include the cost/time if a choice uses paid generation or a long render.

Keep it short: the whole message should fit on one screen. Reply in the user's language.

## Takes

- Never delete or overwrite earlier takes; mention that they're in `takes/` and the ledger (`takes_log list`) if there were several.
- If you made alternatives, show them side by side and say which you picked and why; the user may prefer another.
- If the user picks another take, `takes_log pick` it and continue from that one.

## Honesty rules

- Report failures and limitations up front (a render that failed, a missing key, a step you skipped), with what you did instead.
- Don't inflate: avoid "stunning", "perfect", "professional-grade". Let the work and the references speak.
- If the review loop hit the round limit with axes still below 7, say which ones and what would improve them.
- Distinguish facts from taste: measured ("-14.2 LUFS, no black frames") vs judged ("the grade feels close to ref 2").

## Template

```
**Gotowe:** takes/<name>-take-NN.<ext> — <one-line spec>
[image / contact sheet]
Co zrobiłem:
- …
Czym się jeszcze różni od referencji:
- …
Dalej mogę: A) … B) … C) …
```
(Translate the headings to the user's language.)
