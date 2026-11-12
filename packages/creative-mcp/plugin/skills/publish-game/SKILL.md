---
name: publish-game
description: Publish, update or take down a static HTML/JavaScript game - itch.io (butler), GitHub Pages, Cloudflare Pages/Workers static assets or Netlify - with a pre-publish review of every public file, embed snippet and X player-card checks. Use when the user wants a game online, shareable, embeddable or posted on X.
---

# Publish a game

Open Herness has no hosting of its own: publishing goes to a host on the **user's** account, and the user signs in themselves. Publishing makes every included file public, so it needs the user's explicit go-ahead for that exact build.

## 1. Prepare the build

- Pick the exact build folder that contains `index.html` (e.g. `dist/`). Relative URLs only (`./assets/...`, Vite `base: './'`), all assets bundled locally, no backend code.
- **Review before upload**: list every file that will be public with sizes and the total, and point out anything that should not ship (source maps with secrets, `.env`, raw PSD/blend files, test saves, credentials). Show the list to the user with a content hash of the folder (`find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`). If anything changes after the review, review again.
- Include `CREDITS` for third-party assets.

## 2. Choose the host

| Host                                                                               | Good for                                   | How                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| itch.io                                                                            | game audiences, downloads, browser play    | `butler` (below)                                                       |
| GitHub Pages                                                                       | free static URL from a repo                | push `dist/` to a `gh-pages` branch or a Pages workflow (`gh` CLI)     |
| Cloudflare Pages / Workers static assets                                           | fast global static hosting, custom headers | load the `cloudflare:wrangler` skill; `npx wrangler pages deploy dist` |
| Netlify                                                                            | drag-and-drop or CLI                       | `npx netlify deploy --dir dist --prod`                                 |
| Ask which account they want to use. Never create accounts or buy domains for them. |

## itch.io with butler

- `butler` cannot create the game page: the user creates it on itch.io and signs in once with `butler login` in their own terminal (opens a browser).
- Upload: `butler push <folder> <user>/<game>:<channel>`; later pushes to the same channel send only the changes. Channel names containing `win`/`windows`, `linux`, `mac`/`osx` or `android` set the platform tag; `--userversion 1.2.0` labels the version.
- Browser builds need `index.html` at the folder root. After the first push the user sets the project type to HTML and ticks "This file will be played in the browser" on the Edit game page - butler cannot do this.

## Embedding and X

- Embed snippet for any site: `<iframe src="https://<game-url>/?embed=1" width="480" height="480" allow="autoplay; fullscreen" title="<Game title>"></iframe>` (the game must implement `?embed=1`).
- For X: the host must allow framing (`frame-ancestors *`, no `X-Frame-Options`), send no restrictive `Cross-Origin-Opener-Policy`, and serve the player-card meta tags; on Cloudflare/Netlify set these with a `_headers` file. Verify page and poster return HTTPS 200 and the tags are in the served HTML.

## Update, rename, unpublish

- Update by publishing the same folder to the same project/channel/branch; keep the URL stable and tell the user if a host change would change it.
- After a timeout or uncertain upload, check the host's current state (itch page, `butler status <user>/<game>:<channel>`, Pages deployment list) before retrying.
- Taking a game down: itch (set the page to draft/restricted), GitHub (disable Pages or delete the branch), Cloudflare/Netlify (delete the deployment/project) - explain which, ask, then do it.
- If a host refuses content, show its reason verbatim and stop; never disguise content to get past a check.

## Hand-off

The confirmed public URL (open it once to verify it loads and plays), controls, what you validated, and the embed snippet if relevant.
