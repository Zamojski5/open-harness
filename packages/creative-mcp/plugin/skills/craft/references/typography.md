# Typography

## Choosing fonts

- Max **two families** per piece (one display, one text), often one family in two weights is better.
- Pairing rules that work: grotesk sans + transitional/old-style serif; geometric sans + humanist serif; condensed display + neutral sans. Pair by contrast of structure, not by two similar sans.
- Free, safe families (SIL OFL): Inter, IBM Plex Sans/Serif/Mono, Source Sans 3 / Source Serif 4, Manrope, DM Sans / DM Serif Display, Playfair Display, Fraunces, Space Grotesk, JetBrains Mono, Bebas Neue, Oswald, Archivo (incl. Black / Narrow), Montserrat, Noto (for non-Latin scripts incl. Polish diacritics). Google Fonts hosts all of these.
- Check the font has the glyphs you need (ą ć ę ł ń ó ś ź ż for Polish, typographic quotes, en/em dash). Render a test line first.
- In EffectCraft call `list_fonts` to see what is available; in HTML load via `@font-face` from local files in `./brand/fonts/` or Google Fonts; wait for fonts before screenshotting (the html-to-png script gives 3 s of virtual time).

## Scale and hierarchy

- Use a ratio scale: 1.25 (calm, documents), 1.333 (default), 1.5-1.618 (posters, social). Example at 1.5 from 32 px: 32 / 48 / 72 / 108 / 162.
- Three levels are enough: headline, support line, small print. Each level must differ in at least two of: size, weight, colour, case.
- Headline line-height 0.9-1.05, tracking -1% to -3% for large sizes. Body line-height 1.4-1.6. ALL CAPS: tracking +5% to +12%.
- Line length for reading: 45-75 characters. Headlines: 2-4 lines, break by meaning, never leave a single short word alone on the last line (widow).

## Minimum sizes (as rendered)

| Medium                        | Minimum                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| Social post 1080 px wide      | Body ≥ 28 px, headline ≥ 64 px; anything below 24 px is unreadable in-feed |
| YouTube thumbnail 1280×720    | 3-5 words max, letters ≥ 90 px tall                                        |
| Video lower third (1080p)     | ≥ 36 px, safe area 5-10% from edges                                        |
| Slide 1920×1080               | Body ≥ 32 px, title ≥ 60 px                                                |
| Print poster A2 seen from 3 m | Headline cap height ≥ 4 cm                                                 |

## Craft details

- Real quotes „…” (Polish) or “…” (English), apostrophe ’, en dash – for ranges, × for dimensions.
- Optical alignment: hang punctuation outside the text block; nudge round letters (O, C) slightly past the margin at display sizes.
- Kern display pairs by eye (AV, To, LT, Wa). Never stretch or squish type horizontally — choose a condensed/extended cut.
- Text over images: place in calm areas, never across faces or busy detail. Prefer a scrim to a drop shadow; if a shadow, make it soft and large, not a 2 px offset.
- Text in generated images is unreliable: set type in a separate layer (HTML/SVG, EffectCraft, Inkscape) on top of the image.

## Text in rendered video

- Exact words, numbers and logos are always set as real text or overlays, never left to an image/video model to spell. Check spelling in the exported file, not the project.
- English copy: US spelling unless the user, brand or project uses another variety. Polish copy: check every diacritic renders.
- Confirm the renderer actually has the face (EffectCraft `list_fonts`, a test frame in Chrome); a brand kit naming a font proves nothing. If a substitute is used, tell the user in one line and ask for the font file.
- Watch descenders, accents and cap height for clipping inside masks, text boxes and line boxes.
- Renderers add no motion blur by default: 1–2 px hairlines and small print shimmer in fast moves — enlarge them or keep them still.
