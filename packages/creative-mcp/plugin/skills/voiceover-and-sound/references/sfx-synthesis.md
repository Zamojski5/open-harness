# Synthesising SFX and beds with ffmpeg

All recipes are verified on ffmpeg 8.0.1 and render 48 kHz 24-bit stereo WAV; each already ends with the WAV flags — just change the bare output name to `takes/<name>-take-NN.wav`. Loudness after rendering (ebur128) is listed so you can set mix levels without listening.

## Building blocks

| Source | Use |
|---|---|
| `sine=f=440:d=2:r=48000` | pure tone |
| `anoisesrc=c=white|pink|brown|blue|violet:a=0.5:d=5:r=48000` | noise; brown = rumble/wind, pink = air/rain, white = hiss/crack |
| `aevalsrc='expr':s=48000:d=3` | any formula of `t`: chords, pitch sweeps, envelopes; `expr1|expr2` = L|R |
| `anullsrc=r=48000:cl=stereo` | silence (padding, placeholders) |

Shaping filters: `lowpass/highpass=f=…`, `bandpass=f=…:width_type=o:w=<octaves>`, `tremolo=f=<Hz>:d=<0-1>` (amplitude wobble), `vibrato=f=:d=` (pitch wobble), `aecho=in:out:delays_ms:decays` (space), `afade=t=in|out:st=:d=`, `volume='expr(t)':eval=frame` (envelopes), `areverse`, `atempo`, `alimiter`.

Envelope idioms inside `aevalsrc`/`volume`: decay `exp(-t*k)` (k 3 = long, 30 = click), swell `t/D`, bell `pow(sin(PI*t/D),3)`, repeat every second `mod(t,1)`. Pitch sweep: phase must be the integral of frequency — for f(t) = f0 + f1·e^(−kt) use `sin(2*PI*(f0*t + f1*(1-exp(-k*t))/k))`; for a linear rise f0→f0+r·t use `sin(2*PI*(f0*t + r*t*t/2))`.

## Recipes

**Wind** (12 s, ≈ −29 LUFS)
```sh
ffmpeg -f lavfi -i "anoisesrc=c=brown:a=0.6:d=12:r=48000" -af "bandpass=f=500:width_type=o:w=2,tremolo=f=0.15:d=0.6,vibrato=f=0.2:d=0.3,lowpass=f=1800,afade=t=in:d=2,afade=t=out:st=10:d=2,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le wind.wav
```
Stronger gusts: raise `tremolo d` to 0.9, `bandpass f` 800. Howl: mix in `sine=f=600` at −30 dB with `vibrato=f=0.3:d=0.8`.

**Low drone / pad** (20 s, ≈ −21 LUFS) — detuned A1/E2/A2/E3 partials, slightly different per channel for width
```sh
ffmpeg -f lavfi -i "aevalsrc='0.20*sin(2*PI*55*t)+0.15*sin(2*PI*55.4*t)+0.12*sin(2*PI*82.5*t)+0.08*sin(2*PI*110.3*t)+0.05*sin(2*PI*164.8*t)|0.20*sin(2*PI*55.2*t)+0.15*sin(2*PI*54.7*t)+0.12*sin(2*PI*82.8*t)+0.08*sin(2*PI*109.8*t)+0.05*sin(2*PI*165.2*t)':s=48000:d=20" -af "tremolo=f=0.1:d=0.3,lowpass=f=900,aecho=0.8:0.7:120|240:0.3|0.2,afade=t=in:d=3,afade=t=out:st=16:d=4" -ar 48000 -c:a pcm_s24le drone.wav
```
Change key by scaling all frequencies (C: ×1.189 from A). Darker: lowpass 500; tense: add a minor second (`58.3` Hz) at 0.05. aecho adds ~0.24 s tail beyond `d`.

**Sub boom / hit** (2.5 s, ≈ −18 LUFS, TP −4) — 100 → 40 Hz drop with decay
```sh
ffmpeg -f lavfi -i "aevalsrc='0.9*sin(2*PI*(40*t+60*(1-exp(-t*12))/12))*exp(-t*3)':s=48000:d=2.5" -af "lowpass=f=200,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le boom.wav
```
Inaudible on phone speakers below ~80 Hz — for social, layer the impact below or raise f0 to 60.

**Impact** (2 s, ≈ −24 LUFS) — boom + white-noise crack + short room
```sh
ffmpeg -f lavfi -i "aevalsrc='0.8*sin(2*PI*(45*t+80*(1-exp(-t*15))/15))*exp(-t*4)':s=48000:d=2" -f lavfi -i "anoisesrc=c=white:a=0.9:d=2:r=48000" -filter_complex "[1]highpass=f=1500,volume='exp(-t*30)':eval=frame[c];[0][c]amix=inputs=2:normalize=0,aecho=0.8:0.5:60:0.3,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le impact.wav
```

**Whoosh / swoosh** (1.5 s, ≈ −24 LUFS) — band-limited noise with a bell envelope
```sh
ffmpeg -f lavfi -i "anoisesrc=c=pink:a=0.8:d=1.5:r=48000" -af "highpass=f=300,lowpass=f=5000,volume='pow(sin(PI*t/1.5),3)':eval=frame,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le whoosh.wav
```
Faster pass: shorter `d` (0.4–0.8 s, change both `d` and the `/1.5`). Bias left/right: append `,pan=stereo|c0=1.0*c0|c1=0.4*c1` (coefficient before channel). For movement across the field render two and `acrossfade`. Place the peak (middle) on the cut.

**Riser** (4 s, ≈ −14 LUFS) — rising sine sweep 100 → 500 Hz + swelling hiss, hard stop
```sh
ffmpeg -f lavfi -i "aevalsrc='0.3*sin(2*PI*(100*t+400*t*t/4))*(t/4)':s=48000:d=4" -f lavfi -i "anoisesrc=c=white:a=0.3:d=4:r=48000" -filter_complex "[1]highpass=f=2000,volume='t/4':eval=frame[n];[0][n]amix=inputs=2:normalize=0,afade=t=out:st=3.9:d=0.1,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le riser.wav
```
End the riser exactly on the reveal frame, follow with the impact.

**Reverse swell** (into a hit)
```sh
ffmpeg -i impact.wav -af "areverse,afade=t=in:d=1.5" -ar 48000 -c:a pcm_s24le reverse_swell.wav
```

**Tick / clock** (1 tick per second, ≈ −30 LUFS)
```sh
ffmpeg -f lavfi -i "aevalsrc='0.6*sin(2*PI*2500*t)*exp(-mod(t,1)*400)':s=48000:d=6" -af "highpass=f=800,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le tick.wav
```
Tick-tock: add a second click at `mod(t+0.5,1)` with 2000 Hz. Tempo: replace `mod(t,1)` with `mod(t,60/BPM)`.

**Room tone** (30 s, ≈ −44 LUFS)
```sh
ffmpeg -f lavfi -i "anoisesrc=c=brown:a=0.05:d=30:r=48000" -f lavfi -i "anoisesrc=c=pink:a=0.01:d=30:r=48000" -filter_complex "[0]lowpass=f=300[a];[1]lowpass=f=3000[b];[a][b]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo" -ar 48000 -c:a pcm_s24le room.wav
```
Lay under the whole narration so gaps between TTS lines never drop to digital silence.

## Check what you made

```sh
ffmpeg -hide_banner -nostats -i x.wav -af ebur128=peak=true -f null -      # loudness + true peak
ffmpeg -i x.wav -lavfi "showspectrumpic=s=600x300:legend=0:scale=log:fscale=log" takes/work/x-spec.png
ffmpeg -i x.wav -lavfi "showwavespic=s=1200x240" takes/work/x-wave.png
```
Read the PNGs: a boom is a bright band at the bottom fading out; a riser is a line climbing to the right; a whoosh is a soft-edged block; ticks are thin vertical lines.

Synthetic sounds are abstract — good for motion graphics, UI, trailers, tension. For realistic foley (footsteps, glass, crowds) use `elevenlabs:sfx` if a key exists, or tell the user what to source.
