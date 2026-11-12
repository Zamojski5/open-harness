---
name: house-style
description: Turn user corrections and stated taste into persistent rules with the house_style tool (and general working preferences with the preferences tool). Use the moment the user corrects your output ("too saturated", "never use yellow captions", "always 24 fps"), states a lasting preference, or approves/rejects a style choice in a way that should apply to future work.
---

# House style

The user should never have to say the same correction twice. Rules saved with `house_style` are injected into every future session (project rules for this project, global rules everywhere) and override defaults.

## When to save — immediately, in the same turn

Save when the feedback is **general** — it would apply to the next piece too:
- A correction of taste or craft: "the text is too small", "less glow", "no lens flares".
- An explicit preference: "I like warm grades", "always end on the logo for 2 s", "captions in sentence case".
- A repeated choice: the user picked the same kind of option twice (e.g. the minimal take both times).

Do **not** save:
- One-off content instructions ("make this one blue", "change the headline to X", "cut the third shot").
- Things already covered by an existing rule (update that rule instead — `add` with the same rule text replaces it).
- Guesses about taste the user didn't express.

If unsure whether it's general, apply it now and ask in one short line: "Should I keep that as a rule for future work?"

## How to write a rule

- One rule per call, **concise and testable**: someone could check a frame and say pass/fail.
  - Good: "Captions: white, sentence case, max 2 lines, 64 px+ on 1080x1920, no yellow."
  - Good: "Grade warm: highlights toward amber, never teal-orange."
  - Bad: "Make things look nicer." / "User didn't like it."
- Lead with the domain (Captions, Colour, Motion, Audio, Type, Logo, Export, Workflow) so rules group well.
- Concrete numbers where the user gave or implied them (sizes, durations, LUFS, hex colours).
- `why`: the user's reason in a few words ("reads as cheap", "client brand guide"). It helps judge edge cases later.
- `scope`: `project` (default) for brand/client/piece-family rules; `global` only when the user signals it applies to all their work ("I always…", "in general…", "never ever…") or it's about how you work with them.

## Confirm in one line

After saving, tell the user in one sentence, in their language, e.g. "Zapisałem regułę: napisy białe, bez żółtego." — then continue the task. No lists, no ceremony.

## Maintaining rules

- `house_style list` before big jobs if you're unsure what's stored.
- If a new instruction contradicts a rule, follow the user and update or `remove` the old rule (by number or a unique part of its text); mention it in one line.
- Keep the set small: merge near-duplicates into one sharper rule.

## Preferences (how to work with the user)

`preferences get|set` holds ~/.open-herness/preferences.md: language, verbosity, how autonomous to be, budget for paid generation, favourite tools. Use it for working style, not visual style. Always `get` first, merge the change, then `set` the full short bullet list.

## Applying rules

Before building and again before the final render, check the output against every house-style rule in the environment block. When a rule makes a request impossible or clearly worse, say so and ask instead of silently breaking it.
