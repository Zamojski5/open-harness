---
name: craft
description: Shared taste reference — load for taste decisions on any visual, motion or audio-visual job (picking a palette or grade, pairing fonts, framing a shot, choosing a lens, timing an animation, checking contrast) and before using third-party material (licenses, attribution, fan art, logos, free asset sources).
---

# Craft reference

Short, opinionated defaults for decisions that make work look intentional. Read only the file you need:

| Decision                                                                              | File                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Palette, colour roles, grading look, contrast, dark/light                             | [references/color.md](references/color.md)                           |
| Fonts, pairing, scale, spacing, line length                                           | [references/typography.md](references/typography.md)                 |
| Framing, thirds, leading lines, lens and camera height                                | [references/composition.md](references/composition.md)               |
| Easing, durations, stagger, cut rhythm, beat sync                                     | [references/motion-timing.md](references/motion-timing.md)           |
| Licences, attribution, fan art, trademarks, sources.json, CREDITS, free asset sources | [references/rights-and-sources.md](references/rights-and-sources.md) |

## Tool

`scripts/contrast.py` (stdlib only; path relative to this skill's base directory) gives the WCAG contrast ratio:

```bash
python3 scripts/contrast.py '#F1FAEE' '#14213D'          # one pair
python3 scripts/contrast.py --grid 14213D FCA311 F1FAEE   # all pairs, best first
```

## Ground rules

1. If `./brand/brand.md` exists, it overrides the defaults here (colours, fonts, voice). Craft rules still apply to _how_ you use them.
2. Decide with references, not adjectives: anchor taste in a moodboard (`reference_board`) and state the choice in one line ("teal/orange split, 35mm at eye height, ease-out 300 ms").
3. One strong idea per frame. When in doubt, remove an element, a colour or a font.
4. When a choice is costly to reverse and the user has not specified it, make 2 takes and let them pick.
