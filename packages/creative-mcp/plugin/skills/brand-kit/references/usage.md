# Making something with the kit

- Read `brand/brand.md` and only the linked files the deliverable needs (palette roles, fonts, logo variants, voice, motion). Capture again only on request for up-to-date brand info or when you know their site changed; not as a routine.
- **Overrides win**: files the user handed you (a font, a logo) and recorded exceptions live in `brand/overrides.md` and beat the captured kit. Never overwrite them on a re-capture; report conflicts instead of deleting the user's edits.
- **Fonts**: check the renderer really has each face (EffectCraft `list_fonts`, a test render in Chrome). If a family falls back to a substitute, say so in one line ("Used Inter instead of Brand Sans: no font file") and ask for the file. Font licences must allow use in video/graphics.
- **Logos**: inspect the file before placing it and choose the variant that works on that background (light-on-dark vs dark-on-light, transparency present?). Never recolour, stretch or effect a logo unless an override allows it.
- **Handoff**: name the kit used and list anything substituted or unavailable — never claim full brand fidelity you didn't achieve.

## Files the user gives you

A font or logo the user supplies for _their own_ brand (attached, or a path): copy it into `brand/fonts/` or `brand/logos/`, add a line to `brand/overrides.md` (what, from where, role e.g. "heading font"), and update `brand.md`. Warn about what you see: a font missing the brand's script (Polish diacritics), a logo with no transparency. Works without a website capture.

## Another company's site

Making a video about some other company (a client, partner or competitor, e.g. explaining a payment provider's API) doesn't turn that company into the project's brand. Study its site with `brand_capture` into its own folder (`brand/<host>/`) as reference material and label it as such in `brand.md`, or keep it in `references/`.
