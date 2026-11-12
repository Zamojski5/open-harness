---
name: make-static-graphic
description: Design layout-driven still graphics — social posts, carousels, YouTube thumbnails, banners, ads, covers, quote cards, infographics, slides exported as images. Use when the deliverable is a PNG/JPG/PDF where type and layout matter more than a rendered scene (for the scene/key art itself use make-image).
---

# Static graphics

Build graphics as **code you can re-render**: HTML/CSS (or SVG) → PNG with headless Chrome. Use EffectCraft when the graphic will also be animated, Inkscape when the user wants an editable vector file. Never ask an image model to set the text.

Use the editor the user asks for, or the editor of the native file they supply (Inkscape for `.svg`, GIMP/Krita for layered rasters). Revise an existing source file in place unless the user wants versions; exports may carry a version suffix. The HTML/SVG and its assets are the editable source — keep them next to the export. Raster compositing outside the browser: `uv run --no-project --with pillow python script.py`. Print/multi-page PDF: Chrome `--print-to-pdf` from the same HTML.

## Brand context and artwork

- An active brand kit (`./brand/brand.md`, `brand-kit` skill, `brand_capture`) answers palette, type and logo: use its files unmodified, in their documented variants; say what was substituted. Pick the logo variant that suits the ground; partner marks never replace the user's own identity.
- Generated pictures come from `make-image` (paid, on the user's key); type, layout, retouching and exports are done here. Exact or revisable lettering and logo geometry are authored here; supplied marks are placed from their files. Generative logo experiments only on request (`make-image`); a raster logo to SVG: `fal-ai/recraft/vectorize` via `media_generate`.
- Text filled with a gradient has to be legible along its whole length; over a dark background let it finish on the brightest accent rather than on navy, deep purple or black. Judge colour in the encoded export — faint glows and patterns can vanish after compression.
- An animated version of the piece is made with `make-motion-graphics` / EffectCraft.

## Workflow

1. **Brief** — platform(s) and sizes (table in [references/platform-sizes.md](references/platform-sizes.md)), the one message, exact copy, CTA, deadline for variants. If `./brand/brand.md` exists, read it first and use its palette, fonts and logo; otherwise suggest `brand-kit`.
2. **References** — `reference_search` 2-3 specific queries (e.g. "swiss style event poster grid", "bold tech conference instagram post"), `reference_collect` 4-8 into a board, `reference_board`, write `references/<board>/brief.md` (palette, type, grid, mood, avoid).
3. **Layout** — choose a grid before placing anything:
   - margins 6-8% of the short side (≈ 64-96 px on 1080);
   - 4-col (square/4:5), 6-col (landscape), 12-col (wide banners); 8 px baseline;
   - one focal element taking 40-60% of the area, headline in the biggest calm zone;
   - reading order Z (image-led) or F (text-led), max 3 hierarchy levels (see `craft` typography.md).
4. **Build** `work/<name>/<name>.html`: one file, fixed `width/height` on `html,body`, `overflow:hidden`, fonts via `@font-face` from the brand folder (relative to the HTML file: `../../brand/fonts/…`) or a Google Fonts `<link>` with `display=block` (verified to load, incl. Polish diacritics), images by relative path. Put copy in clearly marked elements so variants are cheap. Use CSS variables for the palette.
5. **Render** with the bundled script (path relative to this skill's base directory):
   ```bash
   scripts/html-to-png.sh work/post/post.html renders/post-v1.png 1080 1350      # 1x
   scripts/html-to-png.sh work/post/post.html renders/post-v1@2x.png 1080 1350 2 # 2x for retina/print-ish
   ```
   It finds Chrome/Chromium/Brave/Edge, uses a throwaway profile (won't touch the user's running browser), waits ~3 s virtual time for fonts, prints the path and actual pixel size. `Read` the PNG after every meaningful change.
6. **Check** (every round):
   - Thumbnail test: `ffmpeg -y -loglevel error -i renders/post-v1.png -vf scale=200:-2 renders/check-thumb.png` (YouTube: 168 px wide), `Read` it. The headline must still read and the focal point must still pop.
   - Contrast: `python3 ../craft/scripts/contrast.py <text-hex> <bg-hex>` — ≥ 4.5:1 for small text, ≥ 3:1 for large headlines; over photos measure against the worst area or add a scrim.
   - Squint/blur test: `-vf "scale=200:-2,gblur=sigma=3"` — is the hierarchy still obvious?
   - Safe zones for the platform (UI overlays), no text within 5% of edges, no typos, diacritics render.
   - `reference_compare` with `image: renders/post-v1.png`, `board: <board>`: score 1-10 on composition, palette, typography, hierarchy, polish; fix the three biggest gaps; max 3-4 rounds.
7. **Takes and variants** — for the key choice (layout or headline) render 2-3 takes side by side (`-v1`, `-v2`, never overwrite). Once picked, generate the size variants by changing the CSS size/grid, not by scaling the PNG. Re-check each variant's crop.
8. **Deliver** — PNG for graphics with text (JPG q≥90 only for photo-heavy, < 1 MB targets), sRGB. List files with sizes; mention what is still off honestly.

## Layout patterns that rarely fail

- **Big type poster**: 2-4 word headline at 12-18% of width per character height, one accent word in the brand accent, small info block bottom-left.
- **Image + band**: full-bleed photo/render, solid colour band (25-35% height) with text — guaranteed contrast.
- **Split**: 50/50 image and text panel; text panel uses base colour.
- **Thumbnail**: face or object large (≥ 40% height), 2-4 words, high contrast outline/shadow on the cut-out, bright accent, nothing in the bottom-right corner (timestamp).
- **Carousel**: same grid on every slide, slide 1 = hook, last = CTA, a visual thread (line, shape) crossing slide edges.

## SVG and vector

For logos, icons, charts and line art write SVG directly (viewBox in px, text converted only if the font cannot be shipped). Render SVG the same way (pass the .svg path directly to the script — verified; give the SVG explicit width/height matching the render size). For a vector deliverable (print, AI/PDF hand-off) see the `inkscape` skill; Inkscape is optional and may not be installed.

## EffectCraft route

When the still is also a video frame or will get motion: build it as a comp (`effectcraft` MCP: `comp.new`, `layer.newText`, shapes, `list_fonts`), check with `render_frame`, export with `render --format png` or `effectcraft-cli render-frame <proj> --comp C --frame N --out F.png`. Same checks as above.

## Pitfalls

- System fonts differ between machines — ship font files or use Google Fonts with a fallback stack.
- Chrome's `--window-size` is the CSS viewport; don't add body margins/scrollbars (the template sets `margin:0; overflow:hidden`).
- Emoji render with the OS emoji font; avoid in brand work.
- Upscaling a 1x PNG for print ruins it; re-render at scale 2-4 or export vector.
