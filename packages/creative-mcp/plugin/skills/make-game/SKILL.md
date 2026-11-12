---
name: make-game
description: Build and playtest a complete small game - browser (Phaser, three.js, PixiJS, Babylon.js, PlayCanvas, KAPLAY), desktop (Godot, LÖVE, Pygame, Bevy, Defold, GameMaker) or a playable X post - with real-input playtests, sourced/generated assets and licence credits. Use for any game, playable prototype or interactive toy; routes to unity-engine, unreal-engine or roblox-studio when the user works in those.
---

# Make a game

## Pick the engine

- New to games, no preference: **Phaser** (2D in the browser), **three.js** (3D in the browser), **Godot** (desktop 2D/3D, see the `godot` skill).
- Others are fine when they fit better: PixiJS, Babylon.js, PlayCanvas, KAPLAY (web); LÖVE, Pygame, Bevy, Defold, GameMaker (desktop). Defold builds outside its editor with Bob (needs Java); GameMaker command-line builds need Igor plus its runtime and licence - neither is bundled, check before promising.
- Unity -> `unity-engine`, Unreal -> `unreal-engine`, Roblox -> `roblox-studio`. Teams already on one of those should stay there.

## The bar

A finished game has the whole loop: **start screen -> play -> win or lose -> restart**, with controls shown on screen. Playtest with real input events, not by calling game functions directly; any change to the source invalidates earlier playtests, so test again.

## Workflow

1. Brief: genre, one-sentence core mechanic, controls, target (browser / desktop / X post), length of a run. Read the target guide before writing code: [browser games](references/web.md), [playable X posts](references/x-player-card.md) (plus the browser guide), desktop -> `godot` skill or the engine's docs.
2. Grey-box the core mechanic first; make it fun with rectangles before art.
3. Expose state for tests: a `window.game` object (web) or a `snapshot()` method on the main scene (Godot) returning score, lives, level, game-over flag, player position.
5. Playtest in rounds (below), fix, retest. Then hand off with `present-results` and, for a public release, `publish-game`.

## Playtest

- **Web**: serve the build (`npx vite` or `python3 -m http.server` in the build folder - never `file://` for module builds) and drive it with the browser tools available in the session (Claude in Chrome: navigate, click, key presses, screenshot, run JS to read `window.game`). Without browser tools, use Playwright headless (`npx playwright` script that presses keys and saves screenshots) and `Read` the screenshots.
- **Godot**: see `godot` -> Playtests (an input-replay script that checks `snapshot()` each step and writes a JSON report).
- **Other desktop engines**: run the game, capture with `screencapture`, and use the `computer-use` skill only if a UI step has no scripted route.
- Each round: play a full run to a win and to a loss, check restart resets state, check no console errors, record a 10-20 s clip for the user when useful (`obs` or Chrome recording).

## Hand-off

Path to the playable build (single `index.html` for web where possible), controls, what was tested and how, asset credits (`CREDITS` file), known gaps.
