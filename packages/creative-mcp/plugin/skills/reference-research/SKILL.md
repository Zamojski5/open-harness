---
name: reference-research
description: Research what already works before making an ad, social video, film or campaign - find references with real performance signals (Meta Ad Library, TikTok Creative Center, Google Ads Transparency, LinkedIn, YouTube, craft archives), download them, watch every one deeply with media_watch, verify the claims by looking at frames, and write a pattern map plus a brand expression range. Use at the start of any ad, campaign or video concept, when the user asks "what works in this category", or before judging our piece against the market.
---

# Reference research

## Goal

Make creative decisions from evidence instead of habit. A good research pass leaves you able to say what hooks, formats, pacing, type and sound the best work in this category uses, which performance signal supports each claim, and where our idea can be different. It also shows how strong brands stretch one identity across many pieces, so we do not apply a brand book as a stencil. The result is `references/<board>/library.json` and `patterns.md`.

## What great looks like

- Every reference was actually watched (`media_watch`, with sound), not summarised from a title or transcript. The notes quote what you saw in frames, and a model claim you could not confirm is marked as unconfirmed.
- Each reference carries a performance signal (ad ran for months, ranked in a top-ads list, high engagement relative to the account, awards) or is labelled as craft-only. A pattern with no signal behind it is a hypothesis, and patterns.md says so.
- The pattern map is specific enough to design from: hook types, formats (problem to solution, app demo, people story, UGC or testimonial, POV, list, before and after), pacing, type, sound, CTA, each with examples and the signal that supports it.
- The brand expression range is separate from the pattern map and just as concrete (below).
- You stop because new references stopped teaching you something, not because a count was reached.

## Where to look

Performance signals: Meta Ad Library (ads still running after many weeks are the strongest free signal of profitable creative), TikTok Creative Center top ads (filter by category, country, objective), Google Ads Transparency Center, LinkedIn Ad Library, YouTube (view-to-subscriber ratio, comments, ad formats), and top organic shorts in the category. Craft archives: Ads of the World, Cannes Lions, D&AD, Motionographer, and the brands' own channels. Open [references/sources.md](references/sources.md) for what each source shows, its quirks and how to query it.

Find pages with WebSearch and WebFetch, stills with `reference_search`, and bring videos in with `reference_download` (public URL, 720p or less, receipt saved in library.json). Ad-library pages are often login-gated or dynamic; the Chrome tools can read them, or ask the user for the file or a screen recording. Never scrape around a login.

## Watching

Run `media_watch` on every candidate, with a question that matters for the project (for example "what makes the first three seconds work for a parent scrolling?"). Use the strong model for the two or three references that will anchor decisions. The tool measures cuts and loudness itself and cross-checks the model against them and against OCR of the frames; treat DISPUTED lines as leads, open the returned frames, and settle each one yourself. The model can hallucinate a word or call continuous motion "quick cuts", so a claim you cite should have been seen or measured.

Watch ours with the same questions when we have a draft, so the comparison is like for like (see `production-pipeline` and `quality-loop`).

## The loop

Keep adding references while they teach something. As a rule of thumb that is eight to twenty clips, and you can stop when about three new ones in a row add no new pattern, a new hook, a new way of using sound or type. Mix in some references from outside the obvious competitors (adjacent categories, other countries), because the category's habits are often the thing to avoid or to subvert. After each clip add its row to library.json (signals, what it shows, patterns it exemplifies, anything to avoid) so the work survives a long session.

## Branding in the references

Study how strong brands flex their system across formats and pieces: same brand, different layouts, colour pairings, photo or illustration styles, type scale, motion. Look at the brand's whole output, several pieces side by side, and at the client's own range too: every existing key visual, illustration, photo, site section and past campaign, not only the brand book. A brand book describes constants; the range shows how much room there really is.

Write a **brand expression range** into patterns.md. Constants are what stays fixed in every piece (logo and its clear space, type families, the palette set, voice, a few recurring devices). Variables are what the strong examples change from piece to piece (layout and composition, which colour pairing from the palette leads, image style, scale and crop, motion language, tone of the copy), each with two or three real examples. Name which variables are hardly used so far; that is where distinctive work often sits. Copying one piece's look for everything is the usual failure, so the range should make the options visible.

## Pitfalls

- Treating one viral clip as a rule. Look for the pattern across several, and note survivorship bias (you only see what survived).
- Confusing popularity with fit. Reach in another category or audience says little about ours.
- Copying. Reference shots, text, music and compositions are never reused; patterns are.
- Believing the model about on-screen text, spoken words and cuts without checking.

## Output

`references/<board>/library.json` (one entry per clip: receipt from the download, signals, watch breakdown path, notes) and `references/<board>/patterns.md` with the pattern map, the brand expression range, a short list of "do and avoid", and the open questions research could not answer. Hand these to `campaign-strategy`.
