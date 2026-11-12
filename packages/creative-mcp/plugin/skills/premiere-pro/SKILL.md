---
name: premiere-pro
description: Hand cuts to Adobe Premiere Pro and change existing Premiere sequences — build a new cut as a Premiere/FCP7 XML timeline with linked clips and text titles, import it, or edit a closed .prproj. Use when the user finishes or edits in Premiere Pro.
---

# Premiere Pro

Status: **untested here** (Premiere not installed). Proprietary (Adobe subscription).

## Before cutting

Choosing takes, lines or cut points: review the footage locally first (`media_inspect`, `media_frames`, `media_review`; transcript if a local whisper exists).

## New cut → XML

- Write the cut as **FCP7 XML (xmeml)**: one `<sequence>` with timebase/NTSC flags matching the footage, video and audio tracks, every `<clipitem>` pointing at a `<file>` with an absolute `file://` `pathurl`, so nothing comes in offline. Linked A/V clips via `<link>` entries.
- Titles stay **text** (a Premiere text/graphic item or a generator with the string), not rendered images, so the user can edit them.
- Import: if Premiere is open, File → Import the XML into the open project (the `computer-use` skill if the session has UI control, else ask the user). It arrives as a new sequence; check it opened with clip count and duration matching your cut.

## Change an existing sequence

Edit it **in place**; don't rebuild it (titles, fades, music, markers).

- Either drive Premiere's UI with computer use, or: user closes the project → `.prproj` is **gzipped XML** (`gunzip -c p.prproj > p.xml`, edit, `gzip -c p.xml > p.prproj`, keep a backup copy) → reopen.
- Premiere overwrites a `.prproj` that was changed on disk while open — never edit it while open.

## Export and effects

Export, effects, ripple edits and UI checks are UI work (`computer-use`). Premiere's own scripting (ExtendScript/UXP) is not part of this skill. Verify any export with `media_inspect`, `media_frames`, `media_review`.

## Limits

Import/export clicks need UI control (`computer-use`) or the user's hands; no Premiere scripting route here.
