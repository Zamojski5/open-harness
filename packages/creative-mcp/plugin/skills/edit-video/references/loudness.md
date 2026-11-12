# Loudness normalisation

## Targets

| Content | Integrated | True peak | LRA |
|---|---|---|---|
| Social video, music, trailers | −14 LUFS | −1 dBTP | ≤ 11 |
| Voice, podcast, explainer, e-learning | −16 LUFS | −1.5 dBTP | ≤ 8 |
| Broadcast (EBU R128) | −23 LUFS | −1 dBTP | as programme |

Normalise the **final mix** once, at the end. Don't normalise stems individually to the delivery target — balance them by ear-equivalent numbers first (see the voiceover-and-sound skill), then master.

## Script (preferred)

```sh
bash <skill-dir>/scripts/loudnorm2pass.sh takes/mix.wav takes/master-take-01.wav -16 -1.5
bash <skill-dir>/scripts/loudnorm2pass.sh takes/cut.mp4 takes/cut-loud-take-01.mp4      # -14 / -1 default
```

It measures, applies, forces 48 kHz, stream-copies video into .mp4/.mov/.mkv outputs, refuses to overwrite and re-measures with `ebur128`. Exit 0 = PASS (within 1 LU, peak under target); exit 3 = WARN with a gain-correction command to run.

## Manual two-pass

```sh
# pass 1: measure
ffmpeg -hide_banner -nostats -i in.wav -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -
# → copy input_i, input_tp, input_lra, input_thresh, target_offset from the JSON
# pass 2: apply
ffmpeg -i in.wav -af loudnorm=I=-14:TP=-1:LRA=11:measured_I=-21.79:measured_TP=-20.79:measured_LRA=0.10:measured_thresh=-31.79:offset=-0.02:linear=true -ar 48000 -c:a pcm_s24le out.wav
# verify
ffmpeg -hide_banner -nostats -i out.wav -af ebur128=peak=true -f null -     # read "I:" and "Peak:" in the Summary
```

## Pitfalls (observed here)

- `loudnorm` resamples to 192 kHz internally — always set `-ar 48000`.
- `linear=true` is only honoured when the needed gain fits under the true-peak ceiling and input LRA ≤ target LRA; otherwise loudnorm switches to dynamic mode (it compresses a little). That is usually fine.
- On bursty/very dynamic material loudnorm's pass-1 integrated value can disagree with `ebur128` by several LU (seen: −30.1 vs −25.2 LUFS). Raising LRA to force linear mode then lands far off target (−9.1 LUFS for a −14 target). Keep the default LRA, always verify, and fix misses with plain gain: `-af volume=<target − result>dB,alimiter=limit=0.85:level=false` (verified: −9.1 → −14.0 LUFS). Re-running loudnorm on its own output repeats the same mis-measurement.
- Silence measures `-inf`; trim leading/trailing silence or skip normalisation.
- AAC encoding can add ~0.1–0.3 dB of true peak; leave the −1 dBTP margin.
