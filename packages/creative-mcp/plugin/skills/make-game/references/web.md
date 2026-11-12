# Browser games

- Default stack: Vite + the engine from npm. Set `base: './'` in `vite.config` so every asset URL is relative; bundle fonts, images, audio and JSON locally (no CDN calls at runtime).
- Prefer one self-contained `index.html` for the hand-off (`vite-plugin-singlefile`) so it opens by double-click and uploads anywhere. Large audio/texture sets can stay as a `dist/` folder instead.
- Make the game object reachable as `window.game` in development so tests can read score/state and so a browser tool can drive it.
- Audio starts only after a user gesture (browser autoplay rules): start music on the first click/key.
- Size the canvas to the window with a fixed logical resolution and letterboxing; test 16:9 desktop and a phone-sized viewport if touch is in scope.
- Static hosting only: no backend code. Real-time shared rooms need the user's own server (WebSocket host) and a host that allows those connections - say so before promising multiplayer.
- Playtest via the dev server URL, never `file://`, and repeat after every source change.
