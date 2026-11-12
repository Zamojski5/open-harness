# Playable X posts (player card)

X can show a game inline when the shared page carries player-card meta tags. Build on top of the [browser game](web.md) loop.

## Build

- One HTTPS page is both the share page and the full game. It must also work as the player: the same URL with `?embed=1` fills the frame with no page chrome. Test both modes.
- The player is shown in a sandboxed iframe, 480 x 480. Inside it: no `<form>` submission, no `alert`/`confirm`/`prompt`. Keep all controls, score and restart inside the square.
- In embed mode show a small corner link "Open full game" that opens the share page _without_ `embed=1` in a new tab (`target="_blank" rel="noopener noreferrer"`). Keep the `embed=1` flag through any in-game navigation.
- **A square poster is required** (PNG/JPEG/WebP): real gameplay, the game title, and the words "Tap to play". Make it with `make-image` or a gameplay screenshot plus HTML text (`make-static-graphic`). Ship it inside the build.

## Meta tags (when the host does not add them)

`twitter:card=player`, `twitter:title`, `twitter:image` (absolute HTTPS URL of the poster), `twitter:player` (absolute URL + `?embed=1`), `twitter:player:width=480`, `twitter:player:height=480`. Keep sharing the stable root URL; version asset URLs, not the page URL.

## Hosting headers

- The player response must allow framing by any site: `Content-Security-Policy: frame-ancestors *`, and no restrictive `X-Frame-Options`.
- Send no `Cross-Origin-Opener-Policy` (or `unsafe-none`): the new tab opened from the frame inherits X's sandbox and Chromium blocks other values.
- Verify after publishing: the page and poster return HTTP 200 over HTTPS, the meta tags are in the served HTML (fetch it as a crawler would), and the headers above are present. X decides whether to actually play inline, so the full game must work in a normal browser too.
