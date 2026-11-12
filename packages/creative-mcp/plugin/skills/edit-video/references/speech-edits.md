# Speech edits by transcript

Edit talking footage and narration by its words: pick lines, drop fillers and retakes, swap a line, duck music, and time captions — all from one word-timed transcript.

## Get word timings once

- A recording: `python3 ../../voiceover-and-sound/scripts/word_times.py rec.wav --lang pl` → `rec.words.json` (`words:[{w,start,end}]`, `pauses`, optional `diff` with `--script`). A video is transcribed from its audio (extract first: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 rec.wav`).
- Generated narration: transcribe the chosen take once and keep its `.words.json` beside it; reuse it for captions and cuts instead of transcribing again.
- Lyrics or sung vocals: speech detectors drop singing; use the whisper engine (not `--engine silence`), give the language when known, and check every line against the supplied lyrics — instrumentals produce phantom words.
- **Speaker labels** are not produced locally. When the edit needs them, a paid diarizing speech-to-text model on fal is the route: find it with `media_models` (query "speech to text"), `media_estimate` it and tell the user who pays before running. Hosted Scribe-type endpoints take files under ~20 min; split longer audio at silences and tell the user speaker identities across chunks are best-effort.
- **Voice isolation** (dialogue over noise/music) is likewise a paid fal audio model; same estimate-and-payer rule. Free first try: `afftdn`/`anlmdn` + `highpass` (see voiceover-and-sound).

Whisper word edges are 0.1–0.3 s off. Put cuts in the middle of pauses, keep about 0.15 s of air next to speech, and confirm an edge with `--engine silence` when a cut must be tight.

## The edit recipe

Write the edit as data first (`takes/work/edits.json`), then render it in one pass. Keep it so the next change is one line:

```json
{
  "picture": "follow",
  "joinFadeMs": 8,
  "segments": [
    { "id": "intro", "start": 0.0, "end": 2.0 },
    {
      "id": "line2",
      "start": 4.0,
      "end": 6.0,
      "replacement": "takes/vo-line2-take-02.wav",
      "fit": "natural",
      "caption": "Open the export menu."
    }
  ],
  "music": { "path": "takes/bed.wav", "gainDb": -18, "duck": true },
  "loudness": -16
}
```

- **Segments play in listed order**; times are seconds on the source timeline, taken from word times (first word start − lead, last word end + trail).
- `picture: "follow"` — picture, captions and any overlays share the speech cuts. `"locked"` — the picture timeline stays whole; segments must cover it unchanged (audio-only fixes).
- **Replacement audio**: `fit: natural` uses its own length (picture of that segment is held/trimmed to match); `pad` adds silence to fill a longer span; `stretch` changes speech rate to fit (`atempo`, pitch preserved — keep within 0.9–1.1 or it sounds processed).
- **Join fade** 8 ms in and out at every audio join kills clicks; 0 disables. Fade, don't crossfade, so the length stays exact.
- Optional cleaned dialogue track (same timing as the original) replaces the source audio before cutting; a music bed is placed under the result and ducked (sidechain numbers in voiceover-and-sound); loudness normalisation is opt-in and runs last (`../scripts/loudnorm2pass.sh`).

Render with one `filter_complex`: for each segment `trim`/`atrim` + `setpts`/`asetpts=PTS-STARTPTS`, `afade=t=in:d=0.008,afade=t=out:st=<len-0.008>:d=0.008`, then `concat=n=N:v=1:a=1`. Write the graph to a file and pass `-/filter_complex graph.fg`. Output beside the video: the edited WAV/MP4, an SRT built from the kept words (shifted to output time), and a short measurement note (`ebur128` I/TP).

After rendering, listen-check by measurement: at every join run `silencedetect` and look at the waveform (`showwavespic`) for a clipped word onset; any join where a word's start/end sits within 30 ms of the cut needs more lead/trail. Overlapping voices, or one clip's tail bleeding into the next, count as bugs unless you layered them on purpose.

## Whose voice

- Words wrong in **a person's own recording**: fix in their voice only with a clone they own and consented to (no clone tool here — say so and offer re-recording the line, or cutting around it). Never patch a real person's speech with a stock voice.
- **Generated narration**: regenerate the line or passage per voiceover-and-sound (takes and repairs), then drop it in as a `replacement`.

## Captions from the transcript

Cue rules: a new cue after every pause of ≥ 500 ms and every sentence end; each cue ≤ 3 s and ≤ 48 characters; cue start/end are the first/last word times. Social short-form can go shorter (1–4 words per cue). Sidecar SRT/VTT come straight from the cues; burned-in captions follow [subtitles.md](subtitles.md).

```python
import json, sys
w = json.load(open(sys.argv[1]))["words"]; cues, cur = [], []
for i, x in enumerate(w):
    cur.append(x); text = " ".join(y["w"] for y in cur)
    gap = (w[i+1]["start"] - x["end"]) if i + 1 < len(w) else 9
    if gap >= 0.5 or x["w"].endswith((".", "?", "!")) or len(text) >= 48 or x["end"] - cur[0]["start"] >= 3:
        cues.append((cur[0]["start"], x["end"], text)); cur = []
ts = lambda t: f"{int(t//3600):02}:{int(t%3600//60):02}:{int(t%60):02},{int(t*1000%1000):03}"
print("\n".join(f"{n}\n{ts(a)} --> {ts(b)}\n{t}\n" for n, (a, b, t) in enumerate(cues, 1)))
```

## Frames around a timestamp

`media_frames` samples evenly across the whole file. For in/out decisions at known times, extract a burst around each boundary and tile it into one sheet:

```sh
T=65.2; mkdir -p takes/work/around
for i in $(seq 0 12); do t=$(echo "$T + ($i-6)*0.25" | bc); \
  ffmpeg -v error -ss $t -i in.mp4 -frames:v 1 -vf scale=320:-2 takes/work/around/f_$(printf %02d $i).png; done
ffmpeg -v error -i takes/work/around/f_%02d.png -vf tile=13x1:padding=4 -frames:v 1 takes/work/around-65.2.png
```

The 7th tile is the stated time; neighbours are ±0.25 s steps. Read the sheet, pick the frame, convert back to seconds. (No text burn-in on this ffmpeg — keep the order in mind or label tiles with Pillow.)
