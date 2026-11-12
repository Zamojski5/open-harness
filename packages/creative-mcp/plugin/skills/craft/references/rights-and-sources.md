# Rights and sources

Not legal advice — a practical policy for keeping the user out of trouble. When something is commercial and unclear, say so and suggest asking a lawyer or the rights holder.

## Licence cheat-sheet

| Licence                                         | Use commercially | Modify | Must do                                                                |
| ----------------------------------------------- | ---------------- | ------ | ---------------------------------------------------------------------- |
| CC0 / public domain                             | yes              | yes    | nothing (credit is still polite)                                       |
| CC BY                                           | yes              | yes    | credit author, licence, link, say if changed                           |
| CC BY-SA                                        | yes              | yes    | credit + release your derivative under BY-SA (bad fit for client work) |
| CC BY-NC                                        | **no**           | yes    | credit; non-commercial only                                            |
| CC BY-ND                                        | yes              | **no** | credit; no edits (no crops into composites)                            |
| SIL OFL (fonts)                                 | yes              | yes    | don't sell the font file alone; renamed if modified                    |
| "Royalty free" stock (Unsplash, Pexels licence) | yes              | yes    | read the site licence; no implied endorsement; no reselling as-is      |
| Found on Google / Pinterest / ArtStation        | —                | —      | **reference only**, never in the final output                          |

Attribution line format: `"Title" by Author, CC BY 4.0, <link> — cropped and colour graded`.

## References vs. assets

- Moodboard images are for learning shape, palette, light and composition. Do not trace, paste or img2img them into deliverables unless the licence allows it.
- Final assets must come from: things you made (Blender, EffectCraft, HTML), generated outputs from models the user has keys for (check the provider's terms for commercial use), CC0/CC BY sources, or files the user supplied and owns.

## Fan art, characters, trademarks

- Recognisable characters, franchises, logos, game UI, and celebrity likeness belong to someone. For personal/fan use: OK to make in the spirit of, but don't use official logos or claim affiliation. For commercial/client use: don't — propose an original design "inspired by" the qualities (palette, era, mood) rather than the IP itself.
- Never generate a real person's likeness in a misleading or endorsing context.
- Don't put other companies' logos on mockups that suggest partnership. Use the user's own brand from `./brand/`.
- Music: only tracks the user owns, CC/royalty-free libraries with commercial licence, or generated/composed audio.

## Keep sources.json

- `reference_collect` already writes `./references/<board>/sources.json` (file, url, page, title, note). Keep it.
- For every third-party asset that ends up in a deliverable, add an entry to `./sources.json` in the project root:

```json
[
  {
    "file": "assets/forest.jpg",
    "url": "https://commons.wikimedia.org/wiki/File:…",
    "author": "Jane Doe",
    "license": "CC BY 4.0",
    "used_in": "renders/poster-v3.png",
    "changes": "cropped, graded",
    "credit_required": true
  }
]
```

- Before delivery: list every `credit_required: true` entry in the hand-off message and offer a ready-to-paste credits line.
- Fonts: record family + licence (`OFL`) in `./brand/brand.md` or sources.json.

## Receipts and the CREDITS file

- Every third-party asset you download gets a receipt beside its files (`<asset-id>.json`: source, id, title, url, authors, license, licenseUrl, attribution text, acquired date, files) and an entry in `./sources.json`.
- Deliver a plain-text `CREDITS` file with the final piece with one line per third-party element (music, samples, fonts, images, models, voice engine) giving its title, author, source URL and licence. Credit on screen when a licence demands it. Tell the user the file lists the licences and that clearing them is their responsibility.

## Free sources worth knowing

| Source                                       | What                                                                                                         | Licence / access notes                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Poly Haven (`asset_search`/`asset_download`) | HDRIs, PBR textures, models                                                                                  | CC0; they ask that users are told assets came from Poly Haven                                                                    |
| ambientCG                                    | PBR materials, HDRIs                                                                                         | CC0                                                                                                                              |
| Kenney (kenney.nl)                           | whole packs: 2D, 3D, UI, audio                                                                               | CC0; each pack ships `License.txt`                                                                                               |
| game-icons.net                               | SVG icons (black square path + white icon path; recolour via `fill`)                                         | CC BY 3.0 per icon author (a few CC0)                                                                                            |
| Incompetech                                  | Kevin MacLeod music                                                                                          | CC BY 4.0 with his credit line; take single tracks                                                                               |
| Lospec                                       | pixel-art palettes: `https://lospec.com/palette-list/<slug>.json`                                            | credit "<palette> by <author> (Lospec)"; author may be blank in JSON — check the page                                            |
| Godot Asset Library                          | plugins/scripts (not art), keyless JSON `godotengine.org/asset-library/api/asset?filter=…&godot_version=4.3` | without `godot_version` the API returns nothing; licence in `cost`; `/asset/<id>` has `download_url`                             |
| OpenGameArt                                  | art and audio                                                                                                | no API; robots.txt asks 10 s between requests and disallows `/search/`; licences (often several, incl. SA/GPL) on each page      |
| Mixamo                                       | rigged characters/animations                                                                                 | terms forbid automated access — the user downloads FBX in their browser; not redistributable raw                                 |
| itch.io                                      | asset packs                                                                                                  | no public search API; free-text licences per page; the user downloads (and pays)                                                 |
| Freesound                                    | recorded SFX, foley, ambiences                                                                               | needs the user's API key; per-sound CC licences                                                                                  |
| Servier Medical Art                          | medical/anatomy illustrations                                                                                | CC BY 4.0, cite as their credit page says; recolouring and splitting allowed                                                     |
| NIH BioArt Source                            | biology/lab icons                                                                                            | free incl. commercial, but check each entry's own licence                                                                        |
| Wikimedia Commons                            | diagrams (often SVG), maps, photos                                                                           | per file; credit the author, not the uploader; BY-SA edits stay BY-SA; API needs a descriptive User-Agent, one request at a time |
