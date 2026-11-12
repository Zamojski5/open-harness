# Colour

## Build a palette by role, not by count

- **Base** (60-70% of area): background/large surfaces. Usually desaturated — near-black, off-white, a deep tint.
- **Support** (20-30%): secondary surfaces, cards, mid-ground.
- **Accent** (5-10%): one saturated hue for the thing the eye must hit first (CTA, title word, the hero object's rim light).
- **Text**: one high-contrast neutral against the base, plus one muted variant for secondary copy.
  Five swatches is plenty. A second accent must earn its place.

## Harmony shortcuts

- **Complementary split** (teal shadows / warm highlights): cinematic, flatters skin. Keep one side dominant.
- **Analogous** (three neighbouring hues): calm, natural, good for nature and product lifestyle.
- **Monochrome + one accent**: the safest way to look designed. Great for posters and brand graphics.
- **Triadic**: playful, kids/games. Desaturate two of the three or it looks like a toy box.
- Avoid pure `#000000` and `#FFFFFF` for large areas on screen; use e.g. `#0E0F12` and `#F5F3EE`. Pure black is fine for print-style posters when intentional.

## Value first

Check the image in greyscale (`ffmpeg -i in.png -vf hue=s=0 grey.png`). If the subject does not separate in grey, no hue choice will save it. Aim for a clear light/dark split: subject against opposite value.

## Grading looks (for renders and footage)

| Look                                                                                                                                                                                                                                                                              | Recipe                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Teal-orange blockbuster                                                                                                                                                                                                                                                           | Shadows toward cyan/teal, highlights toward orange, skin protected, contrast up a little                |
| Bleach bypass                                                                                                                                                                                                                                                                     | Saturation -30-50%, contrast up, slightly crushed blacks — gritty war/thriller                          |
| Pastel / airy                                                                                                                                                                                                                                                                     | Lifted blacks (black point ~8-12%), low contrast, warm highlights — lifestyle, beauty                   |
| Night / moonlight                                                                                                                                                                                                                                                                 | Cool blue overall, keep practical lights warm, underexpose ~1 stop, never crush to pure black           |
| Film emulation                                                                                                                                                                                                                                                                    | Soft highlight roll-off, slight green-cyan in shadows, fine grain 1-3%, gentle halation on bright edges |
| Neon noir                                                                                                                                                                                                                                                                         | Deep near-black base, magenta + cyan practicals, wet reflective surfaces, haze for glow                 |
| In Blender use AgX (default view transform in recent versions) with a "Look" for contrast; avoid "Standard" for lit scenes — it clips highlights. ffmpeg: `eq=contrast=1.1:saturation=0.9`, `colorbalance=rs=-.05:bs=.05:rh=.05:bh=-.05`, `curves`, or a `.cube` LUT via `lut3d`. |

## Contrast and accessibility

- WCAG: body text ≥ 4.5:1, large text (≥ 24 px regular or ≥ 18.7 px bold) and UI glyphs ≥ 3:1, 7:1 for AAA. Check with `craft/scripts/contrast.py`.
- Text over photos: add a scrim (gradient to 50-70% black behind the text area), a solid panel, or blur — then measure contrast against the darkest/lightest part under the text.
- Do not encode meaning by red vs green alone; add shape, label or value difference.
- Saturated red/blue text on dark backgrounds vibrates; lighten it or add weight.

## Brand palettes

Pull hex values from `./brand/brand.md`. If a brand accent fails contrast as text, keep it for shapes/backgrounds and set text in the brand's neutral.

## After compression

- Judge colour and faint detail in the encoded delivery file, not the project: soft glows, subtle patterns and watermark-level shapes can vanish after H.264.
- Platforms re-encode everything; smooth gradients band. Add fine animated grain in the comp, or at encode time `-vf "noise=alls=3:allf=t"`.
- A gradient-filled word must stay readable at every stop. On a dark ground end the gradient on the lightest accent, never on navy, dark purple or black.
- Brand exceptions (a colour outside the kit, a recoloured logo) are recorded in `brand/overrides.md`, not improvised; real brand facts beat inferred styling.
