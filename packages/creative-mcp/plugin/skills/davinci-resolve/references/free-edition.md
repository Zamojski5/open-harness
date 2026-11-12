# Resolve Free — file handover

Free refuses external scripting (19.1+) and has no in-app Python (21.1+). What remains: interchange files the user imports, and **Lua** scripts the user runs from Workspace → Scripts. We have no bridge that runs those scripts for them; do not press that menu with AppleScript/osascript or a clicker, and do not install a Python bridge to get around the boundary.

## Route A — interchange timeline (default)

1. Build the cut list yourself: per clip `path`, source in/out (end-exclusive frames at the **source** rate, counted from the file's first frame — don't add embedded start timecode), record position, track, video/audio.
2. Write OTIO (`.otio`, JSON; `pip install opentimelineio` gives a writer and validator), or FCPXML 1.9+/FCP7 XML, or CMX3600 EDL for a single video track. Absolute `file://` paths so media links.
3. User: **File → Import → Timeline** and picks the file. Opening a new project first keeps their work separate.
4. Mixed rates: a clip at another fps lasts `floor((end-start) * timeline_fps / source_fps)` timeline frames — place the next clip from that. Overlapping clips go on separate tracks.
5. Interchange carries the cut; transitions, retimes and effects mostly do not survive. Say so, and be clear that nothing is in Resolve until the user has imported the file.

## Route B — in-app Lua (user runs it)

- Write `<name>.lua` into `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` (or `Edit/`, `Comp/`) — ask before writing there — and tell the user to run Workspace → Scripts → `<name>`.
- Lua sees `resolve` / `Resolve()` and the same object model as Python (`GetProjectManager`, `GetMediaPool`, `ImportMedia`, `ImportTimelineFromFile`, `AddMarker`, `SetCDL`, `SetLUT`, …). Have the script write a JSON/text result file you then read; you cannot see its console.
- Keep each script read-only unless the user asked for the change, and make it refuse to touch a project/timeline other than the named one.

## What to say about the rest

Lift/gamma/gain wheels, curves, qualifiers, windows, new nodes, speed ramps, OpenFX and caption styling are UI work on Free. Offer: a new cut by interchange, media prepared before import (baked in, not editable in Resolve), a finished video rendered with our own tools (`edit-video`), or the Studio route.

## Graphics with alpha for a Resolve edit

Render overlays as ProRes 4444 with alpha (Remotion/HyperFrames/EffectCraft), place them on V2 in the interchange cut; their text is not editable in Resolve. If alpha renders opaque, use a PNG sequence (see traps).
