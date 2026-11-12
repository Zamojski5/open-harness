# Narrated explainer

Designed motion that walks through a concept with a voice over it — how a database index works, what happens after you tap Pay. Narration comes from `voiceover-and-sound`; when no voice route is available, make a captions-led cut where on-screen text carries the script.

## Order

Script approved → one continuous narration take recorded and picked → cue sheet from that take's word timings → picture built to the cue sheet. (Beats ≈ one picture per 6–8 s of narration.)

## Cue sheet

Transcribe the picked take once (`word_times.py TAKE --script script.txt`) and keep `TAKE.words.json`: every word with start and end. Check the diff first — a take with dropped or wrong words is repaired before you time anything to it ([takes and repairs](../../voiceover-and-sound/references/takes-and-repairs.md)).

## Voice track

- Play the picked take as **one continuous audio layer** and time every visual to the cue sheet.
- Don't split the take into one clip per line, and don't stretch or shorten clips to space lines out. Transcribed word ends spill into the following pause and word starts lag the actual onset, so cutting between lines catches a scrap of the next word or swallows a first consonant.
- If any voice audio is cut anyway, check every splice in the render: each cut must fall inside a pause, not within ~30 ms of a word edge (`silencedetect` on the take around each cut point, plus a waveform image). Fix every flagged splice before presenting.

Equations, algorithms and scientific relationships go to `manim`; keep one idea per scene.
