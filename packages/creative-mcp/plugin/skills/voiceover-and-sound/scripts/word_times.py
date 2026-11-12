#!/usr/bin/env python3
"""Word timestamps, pauses and script-vs-transcript check for a narration take.

Usage:
  python3 word_times.py take.wav [--lang pl] [--script script.txt] [--out take.words.json]
                        [--engine auto|faster-whisper|mlx|silence] [--model large-v3]
                        [--min-pause 0.25]

Engines (auto tries in order): faster-whisper (Python package), mlx_whisper (CLI, Apple
Silicon), then ffmpeg silencedetect (no words, only speech segments and pauses).
Output JSON: {engine, duration, words:[{w,start,end}], segments:[{start,end}],
pauses:[{start,end,dur}], diff:[...]} and a short human summary on stdout.
"""
import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", path], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None


def via_faster_whisper(path, lang, model):
    from faster_whisper import WhisperModel  # noqa: raises ImportError if missing
    m = WhisperModel(model, device="cpu", compute_type="int8")
    segs, _ = m.transcribe(path, language=lang, word_timestamps=True, vad_filter=False)
    words = []
    for s in segs:
        for w in s.words or []:
            words.append({"w": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    return words


def via_mlx(path, lang, model):
    exe = shutil.which("mlx_whisper")
    if not exe:
        raise RuntimeError("mlx_whisper not found")
    repo = model if "/" in model else f"mlx-community/whisper-{model}-mlx"
    with tempfile.TemporaryDirectory() as d:
        cmd = [exe, path, "--model", repo, "--word-timestamps", "True",
               "--output-format", "json", "--output-dir", d, "--verbose", "False"]
        if lang:
            cmd += ["--language", lang]
        subprocess.run(cmd, check=True, capture_output=True)
        js = [f for f in os.listdir(d) if f.endswith(".json")][0]
        data = json.load(open(os.path.join(d, js)))
    return [{"w": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)}
            for s in data.get("segments", []) for w in s.get("words", [])]


def via_silence(path, noise_db=-35, min_sil=0.2):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af",
                        f"silencedetect=noise={noise_db}dB:d={min_sil}", "-f", "null", "-"],
                       capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return starts, ends


def norm(t):
    t = unicodedata.normalize("NFC", t.lower())
    return re.sub(r"[^\w]+", "", t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--script")
    ap.add_argument("--out")
    ap.add_argument("--engine", default="auto")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--min-pause", type=float, default=0.25)
    a = ap.parse_args()

    dur = duration(a.audio)
    words, engine, errors = None, None, []
    order = ["faster-whisper", "mlx", "silence"] if a.engine == "auto" else [a.engine]
    for eng in order:
        try:
            if eng == "faster-whisper":
                words = via_faster_whisper(a.audio, a.lang, a.model)
            elif eng == "mlx":
                words = via_mlx(a.audio, a.lang, a.model)
            else:
                words = []
            engine = eng
            break
        except Exception as e:  # try the next engine
            errors.append(f"{eng}: {e}")

    result = {"engine": engine, "duration": dur, "words": words or [], "errors": errors}

    if engine == "silence":
        starts, ends = via_silence(a.audio)
        pauses, segs, cur = [], [], 0.0
        for i, s in enumerate(starts):
            e = ends[i] if i < len(ends) else (dur or s)
            if s > cur:
                segs.append({"start": round(cur, 3), "end": round(s, 3)})
            pauses.append({"start": round(s, 3), "end": round(e, 3), "dur": round(e - s, 3)})
            cur = e
        if dur and cur < dur - 0.05:
            segs.append({"start": round(cur, 3), "end": round(dur, 3)})
        result["segments"], result["pauses"] = segs, pauses
    else:
        w = result["words"]
        result["pauses"] = [{"after": w[i]["w"], "start": w[i]["end"], "end": w[i + 1]["start"],
                             "dur": round(w[i + 1]["start"] - w[i]["end"], 3)}
                            for i in range(len(w) - 1)
                            if w[i + 1]["start"] - w[i]["end"] >= a.min_pause]

    if a.script and result["words"]:
        ref = [x for x in (norm(t) for t in open(a.script).read().split()) if x]
        hyp = [x for x in (norm(t["w"]) for t in result["words"]) if x]
        diff = []
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False).get_opcodes():
            if op != "equal":
                diff.append({"op": op, "script": " ".join(ref[i1:i2]), "heard": " ".join(hyp[j1:j2])})
        result["diff"] = diff
        result["word_accuracy"] = round(1 - sum(max(len(d["script"].split()), len(d["heard"].split()))
                                                for d in diff) / max(len(ref), 1), 3)

    out = a.out or os.path.splitext(a.audio)[0] + ".words.json"
    json.dump(result, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"engine={engine} duration={dur} words={len(result['words'])} pauses={len(result['pauses'])} -> {out}")
    for p in result["pauses"]:
        if p["dur"] >= 0.8:
            print(f"  long pause {p['dur']:.2f}s at {p['start']:.2f}")
    for d in result.get("diff", [])[:20]:
        print(f"  {d['op']}: script='{d['script']}' heard='{d['heard']}'")
    if "word_accuracy" in result:
        print(f"word_accuracy={result['word_accuracy']}")
    if errors and engine != order[0]:
        print("fell back:", "; ".join(errors), file=sys.stderr)


if __name__ == "__main__":
    main()
