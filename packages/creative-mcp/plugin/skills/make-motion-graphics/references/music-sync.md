# Cutting picture to a track

For a lyric video, a music-driven promo or a montage where the user supplies the song or bed. Writing music for a picture that's already cut belongs to `make-music`; hits and risers: `voiceover-and-sound`.

## Measure the grid

`uv run --no-project --with librosa python3 ../scripts/beat_grid.py song.wav` (librosa downloads once) prints tempo, beat times, onset times, `beat_strength`, `tempo_drift`, `stereo_corr` and loudness per second.

- Trust the beat grid when `beat_strength` is clearly above 1 (≈2+) and `tempo_drift` is small (< ~0.05). Otherwise there's no reliable pulse (ambient, rubato, live drift): cut on onsets and phrase changes instead.
- The analysis mixes to mono. If `stereo_corr` is near −1, one channel is phase-inverted and the mono sum cancels — rerun with `--channel left`.
- Use `loudness_per_sec` to find builds, drops and quiet sections for structure.

## Cut

- Cut on the beat or 1–2 frames before it (feels tighter). Beat interval = 60 / BPM s (120 BPM at 24 fps = 12 frames).
- Bigger changes (new section, new location) on downbeats / phrase starts; small changes (text swaps, punches) on beats or onsets.
- Lyric captions: time words with `word_times.py` (whisper engine) and correct them against the supplied lyrics.
