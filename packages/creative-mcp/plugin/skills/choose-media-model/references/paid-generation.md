# Paid generation

Goal: the user gets the result they asked for at the lowest price that keeps its quality, and is never
surprised by a charge. Calls run on the **user's own keys** (fal, Runware, Replicate, Google, OpenAI,
ElevenLabs; `media_set_key`, listed by `media_models`). If the user picks another tool or site, use it with
its own limits and say once that its cost isn't tracked here.

## Before money moves

- **Quote the whole batch right before sending it**: `media_estimate {request, count}`, count = takes plus
  planned retakes, even for one short take. Say the total, the route that runs it and who pays. An earlier
  quote is stale. Everything the go-ahead covers belongs in it: keyframes, music bed, voice, lip-sync, every
  wave of a continuation run.
- **Unknown price** (`usd: null`) is never treated as fitting. Quote the "up to" bound when there is one,
  otherwise say the price is unknown and ask.
- **Cheaper route first.** `media_estimate` prices every seller of the model (Seedance 2.5 on fal, Runware,
  Replicate; Veo / Nano Banana on fal and Google). The cheapest route with a key runs by default; name the
  saving when it is real and say which routes were skipped (no key, can't carry the request). `route:
  "quality"` keeps the model's own provider; a provider name pins one.
- **Above the ask-before limit** (default $5, set by the user; 0 = every paid batch), `media_generate`
  returns APPROVAL_REQUIRED with a card. Show that card as is, nothing pre-selected; after the user picks
  Approve, resend with `approval_id`. Offer priced alternatives in the same message: fewer takes, drafts, a
  cheaper model. A yes covers that batch only.
- **Read the model's prompting guide before its first paid batch** (video: `make-ai-video/references/
  model-prompting.md`; others: [audio and image prompting](audio-image-prompting.md)).
- **Slow models**: when history marks an endpoint slow, ask before its first job even under the limit, with
  the usual time and a faster option and its price.

## Caps

- A cap for the chat comes **only from the user's own words**: `spend_cap_set {usd, quote}` where quote is
  their whole sentence ("Spend up to $20.") or the label of the card option they picked. When they haven't
  given one and it matters, ask once with a card: one option per cap, each label naming it ("Free only
  ($0)", "Up to $5", "Up to $20"), none marked recommended, free text allowed. "Free tools only" =
  `spend_cap_set {local_only: true}`. A plain "yes" to a cap you proposed is not a cap.
- A refusal by a cap means **nothing was sent**. Say in one sentence what is short and which shots are saved
  vs not started, then ask: shrink the batch to what fits, a cheaper model or draft tier, raise the cap
  (their words), or skip. `OH_SPEND_CAP_USD` is a per-day cap for the whole machine.
- An unpriced job under a cap needs `allow_unpriced: true`, only after the user accepted the unknown cost.

## Submit and wait

- Submit every job of an approved batch together (`media_generate_batch` for several), then wait once:
  `jobs_wait {ids, mode: "any"|"all", timeout_seconds ≤ 120}`. No sleep or polling loops.
- `request_id` makes a resend return the same job. Identical requests reuse a finished job for free;
  `fresh: true` only when the user wants another take of the same request.
- After a restart or failed download, `jobs_status {collect: true}` fetches accepted jobs without paying. An
  uncertain job is never resubmitted blindly; `jobs_retry {id}` collects, and asks (`confirm_fresh`) before
  anything that could charge twice.
- Billing wall with jobs still pending: ask how to finish; unless they top up, cancel the pending ones.
- While waiting talk in whole minutes. On `unusuallySlow`/`stalled`, one message: elapsed vs usual, then keep
  waiting, a faster model (quoted, approved, a new take) or cancel (a started job may still be charged).
- Provenance and cost of every take: `media_provenance {path}`; log takes with `takes_log`.

Choosing or approving a take waits until the results are presented.
