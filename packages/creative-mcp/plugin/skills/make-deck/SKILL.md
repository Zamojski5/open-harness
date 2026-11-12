---
name: make-deck
description: Create or revise slide decks delivered as PPTX and/or slide-format PDF (pitch decks, reports, keynote talks, Google Slides imports) with python-pptx or HTML slides, brand-matched, with rendered slide previews checked before hand-off. Use when the user asks for a deck, slides, a presentation, Keynote/PowerPoint/Google Slides file.
---

# Make a deck

## Pick the build route

1. **python-pptx** (default when an editable file is wanted): real text boxes, native tables and charts, speaker notes.
   `uv run --no-project --with python-pptx python work/deck/deck.py` (no global installs needed).
2. **HTML slides printed to PDF** when the deck only has to be shown or sent: one HTML file, one `<section>` per slide at a fixed size (1920x1080 for 16:9), `@page { size: 1920px 1080px; margin: 0 }`, `break-after: page`. Print with headless Chrome: `"<chrome>" --headless=new --no-pdf-header-footer --print-to-pdf=takes/deck.pdf work/deck/deck.html`.
3. A tool the user names wins: "in Keynote/PowerPoint" means drive that app if installed (AppleScript for Keynote/PowerPoint is fine) or edit the native file they gave you; return their format.

Use a project file as the deck's data only when it is about the subject or the user points to it.

## Previews and PDF from a PPTX

Render to look at every slide before hand-off:

- Keynote or PowerPoint installed: export PDF from the app (AppleScript), then rasterise pages for a contact sheet.
- LibreOffice: `soffice --headless --convert-to pdf --outdir takes/ work/deck/deck.pptx`.
- None installed: rebuild the same slides as HTML at slide size and screenshot them with `../make-static-graphic/scripts/html-to-png.sh` for previews, and tell the user the PDF needs Keynote/PowerPoint/LibreOffice or an HTML deck.
  Rasterise PDF pages for review: `magick -density 72 takes/deck.pdf work/deck/p-%02d.png` (or `pdftoppm -r 72 -png`), then a contact sheet, and `Read` it.

## Deliver (when the user did not specify)

| They said                    | Deliver                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Keynote, PowerPoint, "pptx"  | `.pptx`                                                                            |
| Google Slides                | `.pptx` + how to import: Drive -> New -> File upload, then Open with Google Slides |
| "send it", "present it", PDF | `.pdf`                                                                             |
| nothing                      | both `.pptx` and `.pdf`                                                            |

## Brand and type

Read `./brand/brand.md` (see `brand-kit`) or the project brief first; with neither and a named company, offer `brand_capture <site>`. Use the kit's real palette, fonts and logo files unchanged; say what you substituted. Fonts are the main cross-app risk: name every typeface the recipient needs installed, and expect wrapping and chart rendering to differ between Keynote, PowerPoint and Google Slides - check in the app that will present it when you can.

## Craft checks (each round)

- One idea per slide, headline states the takeaway; max ~3 levels of hierarchy; body >= 24 pt at 1080p.
- Contrast with `../craft/scripts/contrast.py` (>= 4.5:1 body, >= 3:1 large). A gradient headline must stay legible at every stop.
- Consistent grid and margins; charts native (python-pptx `add_chart`) so numbers stay editable.
- Look at the contact sheet: overflowing text, orphan words, misaligned edges, placeholder text left in.

## Hand-off

Follow `present-results`: the deck file(s) in `./takes/`, the contact sheet, the typefaces used, and anything illustrative or placeholder (stand-in numbers, stock images).
