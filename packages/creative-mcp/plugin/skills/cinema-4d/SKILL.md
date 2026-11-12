---
name: cinema-4d
description: Script Maxon Cinema 4D headlessly with c4dpy — open, edit and save .c4d scenes, set up render settings and render with Standard or Redshift. Use when the user works in Cinema 4D or hands over a .c4d; for our own 3D work prefer Blender.
---

# Cinema 4D

Status: **untested here** (Cinema 4D not installed). Proprietary (Maxon subscription). Our default 3D tool is Blender (`blender`, live bridge).

## Clarify up front

- New scene, or changes to a given `.c4d`? If given: is that file currently open in Cinema 4D?
- What's delivered: the scene file, rendered frames/video, or both — and with which renderer (Standard or Redshift)?
- Any third-party plugins or external texture files that have to stay linked?

## Headless runner: c4dpy

- Ships inside the Cinema 4D folder: macOS `/Applications/Maxon Cinema 4D <ver>/c4dpy.app/Contents/MacOS/c4dpy`, Windows `c4dpy.exe`. Pick the build matching the scene's version.
- The first start can want a licence/sign-in or hang. In that case stop and hand it to the user — credentials never go into a command.
- Experiments shouldn't touch the user's preferences: `c4dpy -g_prefspath=/abs/project/takes/work/c4d-prefs script.py`.

## Scripting rules

- The Script Manager's ready-made `doc`/`op` variables don't exist here. Load with `c4d.documents.LoadDocument(path, c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS)`, write with `c4d.documents.SaveDocument(doc, path, c4d.SAVEDOCUMENTFLAGS_NONE, c4d.FORMAT_C4DEXPORT)`.
- Anything needing a window fails: dialogs, viewport grabs, `CallCommand` on an active document.
- Rendering: `c4d.documents.RenderDocument(doc, rd.GetDataInstance(), bmp, c4d.RENDERFLAGS_EXTERNAL)` into a `BaseBitmap`, `bmp.Save(path, c4d.FILTER_PNG)`; sequences via the Commandline renderer app.
- A scene open in Cinema 4D is left alone. Write `scene_v002.c4d` in the **same folder** as the original — relative texture paths then still resolve.

## Around it

Textures/HDRIs/references: `make-image`. Renders: `Read`, `media_frames`, `media_review`. Judging motion beyond sampled frames: `choose-media-model` (hosted understanding, paid).

## Limits

Licence prompts need the user; no viewport screenshots headless.
