---
name: cast
description: Keep recurring characters, locations and props consistent across shots with cast cards (cast_create / cast_sheet). Use when the same person, mascot, place or object must appear in more than one image or shot (storyboards, ads, trailers, comics, series), when the user gives photos of a person or product to reuse, or when an output "doesn't look like" the established character.
---

# Cast cards

A cast card is the single source of truth for how something looks: a fixed text description plus role-tagged reference images in `./cast/<id>/`. Every generation, render and likeness check reads from it, so the look never drifts by memory.

## When to make a card
- Anything that shows up in **2+ shots or deliverables**: a hero character, a mascot, a product, a recurring room or street, a signature prop.
- The user hands you photos of a person, pet, product or place to reuse.
- Before a storyboard or multi-shot video: make the cards first, then write shots that refer to them by id.
- Don't make one for a one-off background extra.

## Origin and consent (hard gate)
| origin | when | status |
|---|---|---|
| `generated` | we designed it (render, generation, drawing) | ready |
| `user-photo` | the user's photos of themselves or their own things | ready |
| `real-person` | any other identifiable real person, incl. celebrities, colleagues, family | **draft** until consent |
| `licensed` | third-party IP, a client's licensed character, stock with a model release | **draft** until confirmed |

- A draft card may hold refs and a description, but **never generate or render its likeness**.
- Ask plainly: "Do you have this person's permission (or the licence) to create new images of them for this project?" Only after an explicit yes in their own words: `cast_update {id, consent: true, user_quote: "<their exact words>"}`. Never infer consent from context or from "just do it".
- Refuse regardless of consent: sexual content of real people, impersonation meant to deceive, content putting a real person in a false compromising situation, minors in any risky context.

## Building a good card
1. **Description** (40-120 words, fixed, no action or setting): build, age range, face shape, eyes, hair (colour, length, cut), skin, distinguishing marks, wardrobe with colours and materials, silhouette. Use hex or named colours. Write it once; afterwards change it only on purpose with `cast_update` (and log that in `project_brief decide`).
2. **Refs** — aim for 4-8, each with a role:
   - `hero`: the canonical look, front or 3/4, even light, sharp. Exactly one hero is ideal.
   - `fullbody`: head-to-toe proportions and outfit.
   - `angle`: profile, 3/4 back — the views generators get wrong.
   - `expression`: smile, anger, surprise — only if the story needs them.
   - `outfit`: alternates (label in `note`).
   - `plate`: for locations, empty establishing views at the key time of day.
   - `style`: rendering style refs (line weight, palette, film look) — not identity.
3. No refs yet? Generate a **character turnaround** first (one image: front, 3/4, side, back on a neutral grey background, same lighting), pick the best with the user, then `cast_create` with those crops as hero/angle/fullbody.
4. `cast_sheet {id}` and look at it: refs must agree with each other and with the description. Remove outliers (`cast_update remove_refs`).

## Using a card
**media_generate (images / video)**
- Prompt = shot-specific action/setting/camera + the card's description **verbatim** + style words.
- `references`: the `hero` ref first, then at most 1-2 role refs that matter for this shot (fullbody for wide shots, angle for profiles, plate for the location). Too many refs averages the face.
- Pick a model that supports reference/identity input (check `media_models` / `media_model_schema`); text-only models will drift.
- Image-to-video: first generate or render the still with the card, approve it, then animate that still — identity holds far better than text-to-video.
- Two characters in one frame: generate each with its own refs where possible, or composite; mixing two faces' refs in one call blends them.

**Blender**
- Model it once, save it as `scenes/cast/<id>.blend` (collection named after the id) and record the path in the card's description note or `project_brief decide`. Append/link that collection into every scene; never rebuild it per shot.
- Keep materials and scale identical; take a turntable screenshot and add it as `angle` refs, so generators and Blender agree.
- For locations: save the set as its own .blend and reuse cameras by name.

**Other apps** (Krita, Inkscape, EffectCraft): keep the hero ref open as a visible reference layer, sample colours from it, don't redraw from memory.

## Likeness check (every output with a cast member)
1. Put the output next to the refs: `takes_compare {a: <hero ref>, b: <output>}`, or `cast_sheet` and Read the output image right after it. For extra rigour, give a subagent the sheet and the output (it has not seen your prompts, so it judges only what is visible).
2. Score each feature **match / minor drift / drift** with a one-line reason: face shape, eyes, hair, skin tone, marks, build/proportions, wardrobe and colours, overall impression (would a viewer say it's the same character?).
3. Verdict: any `drift` on face, hair or a signature mark = regenerate (stronger hero ref, simpler prompt, different seed, or a reference-capable model). Minor drift on wardrobe can be fixed locally (inpaint / paint-over).
4. Log the score in `takes_log` note (e.g. "likeness: 7/8 match, hair drift — too long").
5. Tell the user honestly where the likeness is weak; don't call it consistent if it isn't.

## Pitfalls
- Changing the description mid-project silently breaks earlier shots; version it instead (new outfit = new `outfit` ref + note).
- Low-res, heavily filtered or sunglasses photos make bad hero refs; ask for a clear one.
- Stylized cards: keep the style refs consistent too, or the character "changes artist" between shots.
- Don't send a draft card's refs to any external service.
