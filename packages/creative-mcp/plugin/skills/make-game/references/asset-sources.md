# Asset sources for games (licences, receipts, credits)

## Rule for every third-party asset

Next to the downloaded files write `<asset-id>.json` with: source, id, title, url, authors, license, licenseUrl, attribution text, acquiredAt (ISO date), files. Add one line to the project's `CREDITS` file: title - author - source URL - licence. Do this at download time, not at the end.

## Where to get what

| Source                                        | What                                  | Licence / access facts                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poly Haven (`asset_search`, `asset_download`) | PBR textures, HDRIs, models           | CC0; they ask that users are told assets come from Poly Haven                                                                                                                                       |
| ambientCG                                     | PBR materials, HDRIs                  | CC0; direct zip downloads                                                                                                                                                                           |
| Kenney (kenney.nl)                            | whole packs: 2D, 3D, UI, audio, fonts | CC0; each pack has `License.txt`; search by pack name/category                                                                                                                                      |
| game-icons.net                                | SVG icons                             | CC BY 3.0 (a few CC0); credit each icon's author; SVG is a dark square path plus a light icon path - recolour or drop via `fill`                                                                    |
| Incompetech                                   | Kevin MacLeod music                   | CC BY 4.0 with his credit wording; download single tracks only                                                                                                                                      |
| Lospec                                        | pixel-art palettes                    | `https://lospec.com/palette-list/<slug>.json` gives name, author, hex list; author may be blank there (check the page); credit "<palette> by <author> (Lospec)"                                     |
| Godot Asset Library                           | plugins and scripts, not art          | keyless JSON API: `https://godotengine.org/asset-library/api/asset?filter=<words>&godot_version=4.3` (returns nothing without `godot_version`); licence in `cost`; `/asset/<id>` has `download_url` |
| OpenGameArt                                   | mixed art and audio                   | no API; use search pages only, respect the 10 s crawl delay in robots.txt; licences vary per item (often several, incl. SA/GPL) - read each page                                                    |
| Mixamo                                        | rigged characters, animations         | Adobe terms forbid scripted access: the user downloads in their browser, we import the FBX; not redistributable raw                                                                                 |
| itch.io                                       | asset packs                           | no public search API; licences are free text per page; the user downloads (and pays if needed)                                                                                                      |

Generated assets (media_generate, Blender) need a provenance note instead (`media_provenance` covers generated takes).
