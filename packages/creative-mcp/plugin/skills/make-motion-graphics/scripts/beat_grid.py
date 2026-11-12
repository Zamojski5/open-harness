#!/usr/bin/env python3
"""Beat grid for cutting picture to music (or placing a bed's hits).

Run without installing anything permanently:
  uv run --no-project --with librosa python3 beat_grid.py track.wav [--channel mid|left|right] [--sr 22050]

Prints JSON:
  tempo_bpm        estimated tempo
  beats            beat times (s)
  onsets           onset times (s) - drum hits, note attacks; use for hits that are off the grid
  beat_strength    mean onset strength on beats / between beats; ~>2 = a clear pulse you can cut on,
                   ~1 = no audible grid (ambient, rubato) - cut on onsets or phrases instead
  tempo_drift      std/mean of beat intervals; < ~0.05 steady, larger = tempo changes or a bad track
  stereo_corr      L/R correlation; near -1 means one channel is phase-inverted, so the mono mix
                   cancels - rerun with --channel left
  loudness_per_sec RMS per second (0-1), to find drops, builds and quiet sections
"""
import argparse
import json
import sys

import librosa
import numpy as np


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("track")
    ap.add_argument("--channel", choices=["mid", "left", "right"], default="mid")
    ap.add_argument("--sr", type=int, default=22050)
    a = ap.parse_args()

    audio, sr = librosa.load(a.track, sr=a.sr, mono=False)
    audio = np.atleast_2d(audio)
    corr = None
    if audio.shape[0] >= 2 and np.std(audio[0]) > 0 and np.std(audio[1]) > 0:
        corr = float(np.corrcoef(audio[0], audio[1])[0, 1])
    if a.channel == "left" or audio.shape[0] == 1:
        y = audio[0]
    elif a.channel == "right":
        y = audio[1]
    else:
        y = audio.mean(axis=0)
    if not np.any(y):
        sys.exit("track is silent on the chosen channel")

    hop = 512
    strength = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=strength, sr=sr, hop_length=hop)
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    onsets = librosa.onset.onset_detect(onset_envelope=strength, sr=sr, hop_length=hop, units="time")

    ratio = drift = None
    if len(beat_frames) > 1:
        mids = ((beat_frames[:-1] + beat_frames[1:]) // 2).astype(int)
        off = strength[mids].mean()
        ratio = min(99.0, float(strength[beat_frames].mean() / (off + 1e-9)))
        intervals = np.diff(beats)
        drift = float(intervals.std() / intervals.mean())

    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    per_sec = max(1, sr // hop)
    loud = [float(rms[i:i + per_sec].mean()) for i in range(0, len(rms), per_sec)]

    r3 = lambda v: None if v is None else round(v, 3)
    print(json.dumps({
        "tempo_bpm": round(float(np.atleast_1d(tempo)[0]), 1),
        "beats": [round(float(t), 3) for t in beats],
        "onsets": [round(float(t), 3) for t in onsets],
        "beat_strength": r3(ratio),
        "tempo_drift": r3(drift),
        "stereo_corr": r3(corr),
        "loudness_per_sec": [round(v, 4) for v in loud],
    }))


if __name__ == "__main__":
    main()
