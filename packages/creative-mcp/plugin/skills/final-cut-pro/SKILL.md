---
name: final-cut-pro
description: Hand a cut to Final Cut Pro as FCPXML (or an .fcpxmld bundle) — write it, statically check references, times and media paths, then open it in the Final Cut edition present on the Mac. Use when the user finishes or edits in Final Cut Pro.
---

# Final Cut Pro

Status: **untested here** (Final Cut Pro not installed; the checker script was run on synthetic files only). Proprietary (Apple, Mac App Store).

## Before cutting

Choosing takes, lines or cut points: review footage locally first (`media_inspect`, `media_frames`, `media_review`).

## Write FCPXML

- Resources: one `<format>` per frame size/rate, one `<asset>` per media file (`src` or `<media-rep kind="original-media" src="file:///…">`), each with a unique `id`.
- Times are **rational seconds**: `frames × frameDuration`, e.g. 48 frames at 24 fps = `2s`, at 23.976 = `48048/24000s`. Never decimals.
- `<library><event><project><sequence format="r1"><spine>` holds `<asset-clip ref offset start duration>`; connected clips (titles, B-roll, music) use a `lane` attribute.
- Absolute `file://` URLs; relative URLs are resolved against the FCPXML's folder.

## Check, then open

```bash
python3 <this skill>/scripts/fcpxml_check.py /abs/cut.fcpxml   # .fcpxmld bundles accepted
```

Exit 1 = problems (unknown refs, duplicate ids, non-rational times, missing local media); exit 2 = unreadable. `unchecked_media` (remote URLs) needs a separate look; a missing proxy is harmless when the original exists. This is not a DTD validation.

Open in the installed edition — standalone **Final Cut Pro** (`com.apple.FinalCut`) or **Final Cut Pro Creator Studio** (`com.apple.FinalCutApp`):

```bash
open -b com.apple.FinalCut /abs/cut.fcpxml || open -b com.apple.FinalCutApp /abs/cut.fcpxml
```

Opening only requests the import (Final Cut asks which library). Confirm the project actually appeared before saying it was imported; if both `open` calls fail, report the error.

## Rules

Never create or modify `.fcpbundle` library internals. Export from Final Cut is UI work (Share menu) — the user, or `computer-use` if the session has UI control; verify the file with `media_inspect`/`media_frames`.

## Limits

Detect the app with `mdfind "kMDItemCFBundleIdentifier == 'com.apple.FinalCut*'"`. The checker is static only; import success is confirmed in Final Cut.
