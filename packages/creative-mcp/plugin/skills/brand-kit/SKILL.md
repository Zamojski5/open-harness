---
name: brand-kit
description: Capture a brand into ./brand/ (palette hex, fonts, logo files, voice, how its films move) plus a brand.md that every other creative skill reads; add the user's own font/logo files as overrides; place third-party company logos correctly; save and reuse an accepted design direction. Use when the user gives a website, logo, style guide, brand video or files and says "use our brand", "on-brand", "make it look like X company", hands you a font or logo, or before the first branded graphic/video in a project that has no ./brand/ yet.
---

# Brand kit

Goal: one folder that makes every later output on-brand without asking again.

```
brand/
  brand.md          # the contract other skills read (format below)
  overrides.md      # user-supplied files and recorded exceptions; win over captures
  logos/            # chosen logo files: svg first, then png with transparency
  fonts/            # font files only if licence allows local use (OFL etc.)
  swatches.png      # rendered palette card (for eyeballing)
  <name>/           # raw captures from brand_capture / brand_motion, kept for traceability
    kit.md  palette.json  sources.json  screenshot.png  motion.json  assets/{fonts,logos}/
```

If `./brand/brand.md` already exists, read it, show a summary, and only update what the user asks. Unrelated work (transcription, file operations) needs no brand step.

Every user message already carries a short `<oh_brand>` summary of the active brand (palette, fonts, logos, voice, rules, brand characters, motion), built from `brand/brand.md`, else from the one capture folder. Keep the section headings below so the summary stays complete. When several capture folders exist and the user picks one, write its folder name into `brand/ACTIVE`; `brand/NONE` turns the summary off for the project. To list a mascot or character in it, add `"brand": "<brand name or folder>"` to its `cast/<id>/card.json`.

- Making something with the kit (overrides, font substitutes, logo variants, another company's site): [references/usage.md](references/usage.md).
- A font or logo the user hands over for their own brand: [usage](references/usage.md#files-the-user-gives-you) — it goes into `brand/` and `brand/overrides.md` and wins over the capture.
- A real third-party mark (partner, platform, investor, competitor): [references/company-logos.md](references/company-logos.md).
- Saving, choosing or checking a saved look: [references/directions.md](references/directions.md).

## 1. Gather

**From a website** 0. Only the user's own site or company becomes _the_ brand. A video **about** another company uses its site as reference, not as the project's brand ([usage](references/usage.md#another-companys-site)). Do captures yourself, not from a subagent.

1. `brand_capture {url}` (add `name` for a clean folder name). It fetches the page and its stylesheets and writes `./brand/<name>/`: `kit.md` (palette ranked by CSS frequency with accents split from neutrals, theme-color, colour variables, font families by usage, @font-face files, logo/icon candidates, title/headings/copy), `palette.json`, `sources.json`, `assets/fonts/` (open-font hosts only), `assets/logos/` and `screenshot.png`. Look at the returned screenshot.
2. Run it on 1-2 more pages if the homepage is thin (About, Product, a campaign page). JS-heavy sites yield few CSS colours; then trust the screenshot and `reference_board`.
3. `WebFetch` the homepage and About page asking for: tagline, how they describe themselves, tone, recurring phrases, words they avoid. That feeds the voice section.
4. Cross-check the palette visually: `reference_collect` the screenshot, OG image and a product image into board `brand`, then `reference_board brand` for the dominant hex palette of real imagery. CSS frequency over-weights greys; the visual palette shows which accent actually reads as "the brand".
5. Tell the user what the capture could not find (fonts behind a licence, no logo, an unreadable site behind a bot wall — repeat the error as given); never invent the missing parts.
6. Logos: pick from `assets/logos/` (inline SVG or `*logo*` files first, then apple-touch-icon, then an OG-image crop) and copy the chosen ones to `brand/logos/`. Note what is missing (e.g. no light-on-dark version) and ask the user for the logo pack if only favicons were found.
7. Fonts marked "licence unknown" are self-hosted copies: if the family is on Google Fonts / Fontsource (Inter, Archivo, Instrument Serif…), download it from there instead; otherwise record the name and a free fallback.

**From a brand video** (ad, sizzle reel, launch film): `brand_motion {video: <file or URL>, name}` writes `./brand/<name>/motion.json` — cuts per minute, shot-length stats, brightness/saturation, and a contact sheet. Put the numbers in the `## Motion` section of brand.md so edits match the brand's pacing. For a short piece (≤ 30 s) pace from the brand film's **fastest 15 s** (compute the cut count and median shot length inside the busiest 15 s window from the per-shot table), not the whole-film average. Run it when the user adds a brand video or their site has one; one or two videos are enough. Only the brand's own films describe the brand; anybody else's video is just a reference. Values the user set by hand in `## Motion` are theirs: never overwrite them.

**From files the user gives** (PDF guidelines, logo pack, screenshots): read PDFs/images directly, copy logos into `brand/logos/`, sample colours with `reference_collect` (local paths work) + `reference_board`.

## 2. Decide (don't just dump)

- Pick **roles**, not a list: base/background, surface, text, muted text, primary accent, optional secondary accent. Usually 5-7 hex values. Merge near-duplicates (ΔE tiny, e.g. `#25282d` vs `#202327`).
- Check pairs with `python3 ../craft/scripts/contrast.py --grid <hexes…>` and record which combos are text-safe (≥ 4.5:1).
- Fonts: identify family names; check licence. Google Fonts / OFL → download the woff2/ttf into `brand/fonts/`. Commercial fonts (e.g. a licensed corporate typeface) → do **not** download; record the name and a free fallback with similar structure (see `craft` typography.md).
- Voice: 3-5 adjectives, with a "this, not that" for each, and 3 example lines in their style.

## 3. Write brand/brand.md (exact sections — other skills rely on them)

```markdown
# <Brand name> brand

Source: <url or files>, captured <date>

## Palette

| Role | Hex | Notes |
| background | #0E1116 | |
| surface | #1B2230 | cards, panels |
| text | #F4F1EA | 15.8:1 on background |
| muted | #9AA3B2 | secondary copy |
| accent | #FF6B2C | CTAs, highlights; NOT for body text on light bg (2.9:1) |
Text-safe pairs: text/background, background/accent(large only) …

## Typography

- Display: <Family> <weights> — brand/fonts/… (OFL) | fallback: <free family>
- Text: <Family> …
- Rules: headline case, tracking, max two families.

## Logo

- Primary: brand/logos/logo.svg (dark on light) · Inverse: … · Mark only: …
- Clear space ≥ height of the mark's x; min width 120 px digital; never recolour, stretch, add effects.

## Imagery

Photo/illustration style, lighting, subjects, what to avoid. Link board: references/brand/.

## Voice

Adjectives with "this, not that"; sample lines; words to use/avoid; language(s).

## Motion (if a brand video was measured)

Median shot length, cuts/min, brightness/saturation, transitions seen; source brand/<name>/motion.json.

## Gaps

What could not be found (e.g. no inverse logo, font is commercial).
```

## 4. Prove it

Render a swatch + type specimen card so the user can confirm in one look: build a 1600×900 HTML page (palette blocks with hex labels, headline + body in the brand fonts, logo on background and on accent) and render it with `../make-static-graphic/scripts/html-to-png.sh brand/specimen.html brand/swatches.png 1600 900`. Show it, ask "does this match your brand?" and fix before moving on.

## Pitfalls

- Website CSS includes framework defaults (Bootstrap greys `#6c757d`, `#495057`) — ignore those unless they're visibly used.
- Favicons are often simplified marks; don't upscale a 32 px icon as "the logo".
- Respect trademarks: the kit is for the user's own brand or one they work for. For a third-party brand used as inspiration, capture the _qualities_ (see `craft` rights-and-sources.md), not the logo.
- brand_capture records every downloaded file in `brand/<name>/sources.json`; add anything you fetch by hand to `./sources.json` with its origin.
