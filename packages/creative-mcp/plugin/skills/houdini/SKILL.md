---
name: houdini
description: Script SideFX Houdini headlessly with hython — load and edit .hip scenes, cook and cache geometry, render with Karma or Mantra. Use when the user works in Houdini or needs procedural/FX work in an existing Houdini scene.
---

# Houdini

Status: **untested here** (Houdini not installed). Proprietary (SideFX; free Apprentice, paid Indie/FX). Our default 3D tool is Blender.

## Clarify up front

- New scene or a given one? If given: which file, and is the user's Houdini session holding it open?
- Output: the modified scene, geometry caches, or rendered images (Karma or Mantra)?
- Licence flavour of the file: `.hip` commercial, `.hiplc` Indie, `.hipnc` Apprentice/non-commercial. A non-commercial file can't be turned commercial by saving it.

## Headless runner: hython

- Use Houdini's bundled Python only. macOS: `/Applications/Houdini/Houdini<ver>/Frameworks/Houdini.framework/Versions/Current/Resources/bin/hython`; Windows `bin\hython.exe`. Match the version the scene was saved with.
- It takes a licence from the user's existing installation; we never set up licensing.
- Test runs get throwaway preferences: `HOUDINI_USER_PREF_DIR=/abs/project/takes/work/houdini__HVER__` — Houdini only honours the variable when the `__HVER__` placeholder is in it.

## Scripting rules

- `hou.hipFile.load(path)`; a `hou.LoadWarning` counts as failure (typically missing files) — report it, don't continue silently.
- Nodes: `hou.node("/obj/...")`, `createNode`, `parm(name).set(v)`; caches and renders by calling a ROP's `render()`; Karma lives in `/stage` (Solaris), Mantra in `/out`.
- Unsaved changes in the user's open Houdini are invisible to hython. Leave that `.hip` alone and save `scene_v002.hip` next to it, so `$HIP`-relative paths keep working.

## Around it

Textures/references: `make-image`. Renders: `Read`, `media_frames`, `media_review`. Motion judgement beyond frames: `choose-media-model`.

## Limits

Licence checkout depends on the user's install; no live session bridge.
