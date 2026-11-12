---
name: publish-video
description: Publish, draft or schedule a finished video on YouTube (incl. Shorts) or TikTok through the platform's own Studio in a browser, with a pre-post check, a durable receipt per upload and verification of the live post; also check the state of earlier posts. Use when the user asks to post, upload, schedule or publish a video, or asks whether an upload went live.
---

# Publish a video

Use an authenticated publishing integration if one is connected and covers the task; otherwise the platform's Studio through the browser-automation tools available in this session. For a step only the UI can do, follow `computer-use`. If no browser or UI route exists, prepare everything (file, title, description, tags, thumbnail, disclosure answers) and let the user upload, then verify with them.

- [Upload transport](references/upload-transport.md): getting a local file into a browser uploader.

## Before posting

- Shorts, TikTok, Reels: `media_review FILE {platform: "shorts"|"tiktok"|"reels"}`. Fix geometry/duration errors, and check text and faces against the UI zones with the `review-media` safe-area overlay (text under platform controls, a subject cut by the frame edge) — fix or say why it stays.
- Confirm with the user: account/channel, title, description, visibility (private/unlisted/public/scheduled with time zone), AI-generated-content disclosure for picture **and** audio.

## Submit once, keep a receipt, reconcile

Keep `publishing/<platform>/receipts.json` in the project, shaped `{"receipts": [...]}`, one entry per account + file hash + intended release:

| Field                            | Content                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `file`, `sha256`                 | the local file (relative to the project) and its hash                   |
| `account`                        | channel name/handle and stable ID when visible                          |
| `metadata`                       | public title, description, tags, thumbnail file                         |
| `requested`                      | visibility and scheduled time                                           |
| `remoteId`, `url`                | as soon as the platform assigns them                                    |
| `stage`                          | last _confirmed_ stage: `uploaded`, `draft`, `scheduled` or `published` |
| `checks`                         | pre-post checks and their result                                        |
| `actualVisibility`, `verifiedAt` | what the platform shows, and when you checked                           |

- Write the intent before the final publish/schedule click and the result right after. Mark a receipt `published` after you have seen the post live as public or unlisted, not before.
- Never store passwords, cookies or tokens.
- Before any retry, look for the earlier attempt in the platform's content list (by title, time, receipt ID) — a missing row in the first visible page is not proof it failed.

## Finish

Report public titles, links and the accurate per-item state (and any concrete blocker). Stop any temporary upload helper.

Reviewer feedback without publishing (a private review link that collects notes) has no route here: share an unlisted upload or the file itself and ask the user to relay notes.
