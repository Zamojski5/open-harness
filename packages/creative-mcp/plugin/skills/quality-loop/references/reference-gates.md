# Reference and sameness gates

Goal: our piece should stand next to the best work in its category without copying it, and the pieces of one campaign should read as one brand without being clones of each other.

## Gate 1: against the references

When: usually at concept (a sketch or animatic against the pattern map), at first cut, and at final. Skip or merge a gate when it would tell you nothing new, and say why in a line.

How:

1. Choose the three references from `references/<board>/library.json` with the strongest signals that are closest in format to ours.
2. Run `media_watch` on our piece with the same question you asked of them (for example the hook, the pacing, how legible the text is on a phone). Open the returned frames for both.
3. Put contact sheets side by side (`media_frames` or the `shots-sheet.jpg` each watch writes). Compare: does the first three seconds do the job the winners' hooks do; is shot length and cut rate (measured) in the same range or deliberately different; is on-screen text readable at phone size for as long as the references give it; is loudness and sound design at the standard.
4. Write the calibration as concrete changes ("hook text arrives at 1.4 s, winners show it by 0.5 s"), not as a score alone.

Learn from patterns. Never copy shots, text, music or compositions.

## Gate 2: sameness across the campaign

Put every deliverable of the campaign side by side (stills and a mid-frame of each video, one contact sheet). Look in both directions.

Too same: near-identical layout, the same hero image or subject, one colour pairing everywhere, the same headline or the same motion treatment in every piece, unless the strategy asked for a signature that repeats. Brand constants repeating is correct; variables repeating needs a reason.

Off-brand drift: anything that breaks a constant (logo handling, type families, palette set, voice) or moves so far in a variable that the pieces no longer feel like one brand.

Measure rather than eyeball:

- A layout and colour fingerprint per piece: dominant colours (`reference_board` gives a palette, or sample with ffmpeg palettegen), where text and the main subject sit (a coarse 3x3 grid of where the OCR boxes and the brightest or most saturated mass fall), and crop and scale of the subject. Compare pieces pairwise; many pairs with near-identical fingerprints is a sameness flag.
- A reviewer subagent (fresh context) given only the contact sheet, the brand constants and the strategy note. Rubric, each with one sentence of evidence: variety of layout, variety of imagery, colour range used, copy variety, constants respected, intent (does each variable choice serve the direction), overall "one brand, many pieces".
- For text, the `copywriting` reviewer does the same across headlines and CTAs.

Constants are checked strictly (a checklist is fine here: logo clear space and version, type families, palette set, language and voice rules, safe areas, loudness). Variables are judged for intent and range, because there the question is whether the choice was deliberate and whether the range is used.

Fail with concrete fixes: name the pieces, the variable that repeats, and one change each (for example "pieces 2 and 5 share layout and colour pairing: move 5 to the dark pairing and a full-bleed crop, which the range shows is on-brand").
