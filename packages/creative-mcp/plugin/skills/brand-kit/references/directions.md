# Design directions (a saved, accepted look)

A direction records how one project adapts the brand: the accepted treatment and its explicit exceptions. The brand kit stays the source of brand facts.

## Layout

`design/directions/<id>/` with

- `DIRECTION.md` — the accepted treatment in the user's approved wording (palette use, type treatment, layout and motion rules) and every explicit brand exception;
- `manifest.json` — links to the brand files it relies on (with their hashes at the time of saving), relevant guides, the starting style guide and the accepted reference images;
- `references/` — those accepted references.

Save one only when the user asks to keep an accepted look. Saving does not make it the project default; the user decides that (record the default with a `project_brief` decision).

## Using one

Use the active direction for creative work only (not for transcription, file operations or questions). If a linked brand file's hash no longer matches, the brand changed since the direction was saved: review the linked files before claiming adherence. If the direction is broken or missing, mention it once and offer a fix or a different pick; never swap in another one quietly.

## Precedence

1. What the user asks for now, any template they attached, and the recorded brief.
2. The direction chosen for this conversation (including an explicit "don't use it").
3. Real brand facts and brand guides.
4. The direction's style and its recorded exceptions.

Real brand facts beat inferred styling unless the user authorised the exception.

## Reuse elsewhere

Copy the direction folder together with the brand files it links, keeping relative paths and identity; copy only declared inputs. Existing artifacts keep the inputs they were made with.
