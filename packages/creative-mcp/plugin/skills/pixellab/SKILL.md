---
name: pixellab
description: Make pixel-art sprites, directional animations and tilesets with PixelLab through its MCP server — sizes, facing directions, views, palettes, job polling and saving results. Use when the user wants game sprites, character animations or tiles in pixel-art style.
---

# PixelLab

Status: **untested here** (PixelLab MCP not connected). Paid service on the user's own account.

## Clarify up front

- Canvas size per sprite/tile — 32 px, 64 px, other?
- How many facing directions (4 or 8) and which animation cycles (idle, walk, run, …)?
- Camera: top-down, side view or isometric? Any palette or reference picture it must follow?

## Connecting (the user does this once)

PixelLab runs a remote MCP server at `https://api.pixellab.ai/mcp` that authenticates with a Bearer token from the user's PixelLab account. In Claude Code the user adds it with `claude mcp add` (HTTP transport, `Authorization: Bearer …` header). They type the token themselves — it never goes through chat or into files. The tools show up in the next session.

## Using it

- Each generation is an asynchronous job: the call returns an id, which you poll until it completes. Download finished results into the project (`assets/pixel/…`) immediately — some kinds, map objects for example, expire after about 8 hours.
- Terrain for top-down games comes back as a Wang-style tileset (for transitions between ground types). Side-view and isometric tiles use separate tools.
- Inspect sprites with `Read` after a nearest-neighbour blow-up (`ffmpeg -i s.png -vf scale=iw*8:ih*8:flags=neighbor big.png`); animations with `media_frames`.

## No PixelLab?

Use `make-image` / `media_generate` for the pixel art (consistent sheet per direction) instead of drawing it in code; sounds via `voiceover-and-sound`; engine import via `godot`.

## Limits

Connection lives in the harness MCP config; no in-app integration screen.
