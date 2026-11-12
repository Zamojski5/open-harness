# Stage templates

Copy, fill, keep the front matter valid YAML. Field paths in `user_edited` use dots (`shots.S04.action`, `characters.mira.costume`).

## 01-treatment.md

```markdown
---
stage: 01-treatment
status: draft
version: 1
built_from: []
user_edited: []
---
# <Title>

**Logline:** …
**Format:** 16:9, 24 fps, 60 s, English VO, no dialogue
**Audience / platform:** …
**Tone:** 3 words + one reference film/ad
**Look:** <video-styles name> (proposed)

## Beats
1. (0–8 s) … — BUT …
2. (8–20 s) … — THEREFORE …

## Climax choice
…

## Story check
logline ✓ · causality 4 · climax 4 · clarity 3 · … (blockers: none)
```

## 02-breakdown.md

```markdown
---
stage: 02-breakdown
status: draft
version: 1
built_from: [01-treatment@2]
user_edited: []
---
## Characters
### mira
- Invariant line (paste into every prompt): "Mira, a woman in her 60s, wiry, short grey hair, navy wool sweater #1F2A44, yellow oilskin coat #E3B23C"
- Refs: film/<project>/refs/mira-front.png, mira-profile.png
- Never: glasses, jewellery

## Locations
### lighthouse-interior
- Invariant line: "round stone room, brass lamp, whitewashed walls, one small window"
- Light: warm tungsten 2700 K practicals, blue night outside
- Refs: …

## Props
### signal-lamp — brass, hand crank, red lens
```

## 03-shot-list.md

```markdown
---
stage: 03-shot-list
status: draft
version: 1
built_from: [01-treatment@2, 02-breakdown@1]
user_edited: []
---
| Shot | Beat | Dur | Framing / lens | Move | Action | VO/SFX | Source | Join → next |
|---|---|---|---|---|---|---|---|---|
| S01 | 1 | 4.0 | wide, 24 mm | slow push | lighthouse in storm | wind | AI (veo) | CUT (place change) |
| S02 | 1 | 3.0 | medium, 50 mm | static | Mira strikes match | match SFX | AI | CONTINUE (lamp catches; carry: extend) |

Total: 58.5 s (target 60 s)
```

## 04-look-dev.md

```markdown
---
stage: 04-look-dev
status: draft
version: 1
built_from: [02-breakdown@1, 03-shot-list@1]
user_edited: []
---
**Look:** moonlit-fantasy (video-styles) — deviations: …
**Palette:** #0E1A2B #2E4A6B #E3B23C #F2E9D8
**Hero frames:** refs/hero-sc1.png (approved), refs/hero-sc2.png
**Motion test:** takes/motion-test-S05-take-02.mp4 (approved: wave motion, grain)
**Previs:** takes/animatic-v01.mp4 (58.5 s)
**Style clause (paste into every prompt):** "…"
```

## 05-generation.md

```markdown
---
stage: 05-generation
status: draft
version: 1
built_from: [03-shot-list@1, 04-look-dev@1]
user_edited: []
---
## S02
| Take | File | Model / seed | Changed vs previous | Scores (comp/motion/consistency/artifacts) | Artifacts | Verdict |
|---|---|---|---|---|---|---|
| 01 | takes/S02-take-01.mp4 | veo3.1-fast / 11 | — | 7/6/8/5 | hand B @1.8 s | reject |
| 02 | takes/S02-take-02.mp4 | veo3.1-fast / 12 | reframed: hands out of frame | 8/7/8/8 | — | **pick** |
Carry method to S03: rung 1 (extend)
```

## 06-edit.md

```markdown
---
stage: 06-edit
status: draft
version: 1
built_from: [03-shot-list@1, 05-generation@1]
user_edited: []
---
| # | Shot take | In | Out | Transition | Notes |
|---|---|---|---|---|---|
| 1 | S01-take-02 | 0.25 | 4.25 | cut | trim warm-up frames |

**Sound:** VO cue sheet takes/vo-cues.md · music bed … · SFX list …
**Titles:** EffectCraft comp film/<project>/titles.ecproj
**Delivery:** 1920×1080, 24 fps, H.264, −14 LUFS
**Review:** media_review take-03: clean
```

## Staleness check (run before working on any stage)

```bash
python3 - film/<project> <<'EOF'
import re, sys, glob, yaml
st = {}
for f in sorted(glob.glob(sys.argv[1] + '/0[1-6]-*.md')):
    fm = yaml.safe_load(re.match(r'---\n(.*?)\n---', open(f).read(), re.S).group(1))
    st[fm['stage']] = (fm['status'], fm['version'], fm.get('built_from') or [])
for name, (status, ver, deps) in st.items():
    for d in deps:
        dn, dv = d.split('@')
        if dn in st and status != 'stale' and (st[dn][1] > int(dv) or st[dn][0] == 'stale'):
            print(f'{name}: built from {d}, upstream is v{st[dn][1]} {st[dn][0]} -> mark stale')
print('checked', len(st), 'stages')
EOF
```
After marking, re-run until it prints nothing but the count (staleness propagates down the chain).
