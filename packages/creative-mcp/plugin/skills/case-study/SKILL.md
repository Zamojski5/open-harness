---
name: case-study
description: Turn a finished (or running) Open Herness project into sales material backed by its own logs - CASE.md, numbers.json, a one-page PDF and a 45-60 s video in ./delivery/case-study/, built locally with case_study_build. Use when the user asks for a case study, a portfolio piece, "show what this project took", numbers for a pitch, or picks "Build case study" in the project menu.
---

# Case study

A case study sells only if every number survives a sceptical agency's questions. `case_study_build`
computes everything from Open Herness's own logs and lists the source of each number in
`numbers.json`. Your job: get the framing right, keep it honest, review the outputs.

## 1. Ask before building (one question card)

For client work, always ask first, in the user's language, in ONE question card:

- **Confidentiality**: public / confidential (client names redacted, take images and the process
  timelapse blurred) / confidential + relative numbers only (%, ×, /10 scores; no $, durations or
  dates; plain counts such as takes and messages stay; the absolute numbers.json is kept out of
  `delivery/` in `.open-herness/case-study/`).
- If confidential: which names to redact (client, brand, product) → `clientNames`. If the project
  has a brand kit, the per-turn `<oh_brand name="…">` block names the brand: include that name.
- **Spec work?** If this was not commissioned by the brand → `spec: true` (adds "Spec campaign, not
  affiliated").
- **Agency comparison**: only if the user gives their own estimate of how many hours an agency would
  need → `agencyEstimateHours`. Never suggest or invent a number; without it there is no comparison.

Skip the card only for the user's own projects that they already said are public.

## 2. Brief

The default brief is the project's first user message. Read it: if it is a greeting or a
one-liner, write a 1-3 sentence problem statement from the project brief (`project_brief get`) and
pass it as `brief`. Do not add claims the logs don't support.

## 3. Build

`case_study_build` with the answers (optionally `from`/`to` or `threadIds` to scope it, `video:
"both"` for 16:9 too, `music` only if the user gives a local file). It is local and free: no
generation, no network. Building the video takes about a minute.

## 4. Review before presenting

- Read `delivery/case-study/CASE.md` and check the numbers against `numbers.json`.
- Look at the PDF (one page) and a contact sheet of `case-study.mp4` (`media_frames`).
- "not recorded" is correct where data is missing: never replace it with a guess. Say what was
  missing (e.g. "no process frames: Record process was off") and how to get it next time.
- Confidential builds: check that no client name, logo or readable take appears anywhere.
  Redaction catches the names you pass, their inflected forms (Orlenu, Żabką) and the folder name;
  check for nicknames, product names and stem changes (Żabce) it cannot guess.
- Public builds with a timelapse: the frames show the whole Open Herness window, including the
  sidebar with other projects' and threads' names. Look at a contact sheet; if another client is
  readable, rebuild with `confidential: true` or `video: "none"`.

## 5. Present

Name the files with their `delivery/case-study/...` paths (they show in the deliverables card),
the 3-4 strongest numbers with their method in one line each, and what is missing. Offer: edit the
brief, rebuild confidential/relative, add the 16:9 cut.

## Process timelapse

The video's timelapse comes from the desktop app's **Record process** toggle (project menu). It
captures only the Open Herness window every 10 s into `.open-herness/process-frames/` (capped at
500 MB, oldest frames thinned), and pauses while another project is open. Add `.open-herness/` to
the project's `.gitignore` so frames never reach a client repository. Mention it at the start of client projects so the case study has a
timelapse at the end.
