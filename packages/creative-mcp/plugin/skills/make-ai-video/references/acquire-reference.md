# Get a reference video and prepare it for a model

Use the actual footage when it helps the analysis ([reference-video](reference-video.md)) or when a
generation model accepts video references (style transfer, motion reference, tail continuation).

## Getting the file

Open Herness has no built-in online video downloader. In order of preference:

1. The user's own file (brief, attachments, project folder, a path they name).
2. A file the user downloads themselves and drops into the project (ask, with the URL and time range).
3. Stock/open footage downloaded directly from its source ([footage-sources.json](footage-sources.json));
   `reference_collect` stores images and page URLs on a board, not video files.
4. If `yt-dlp` is installed and the user asks for it, run it in the shell with a time range
   (`yt-dlp --download-sections "*12-20" -f "bv*[height<=720]+ba/b" -o "references/<name>.%(ext)s" URL`).
   Don't read browser cookies unless the user wants their login used; don't hammer rate-limited sources.

Keep the source page URL, the range and the licence next to the file (and in `sources.json`). Captions
keep the source's timestamps — offset them before using them against a trimmed cut.

## Prepare it for a model

Read the endpoint's schema first (`media_model_schema`): field name and shape (string vs array),
how many videos, duration range, size/aspect/fps limits, and audio rules. Never silently fall back to an
image-only mode.

Use the original when it already fits. Otherwise write a **separately named derivative**, e.g. 5 s at
1280×720/24 fps without cropping (letterbox to fit):

```sh
ffmpeg -ss 0 -t 5 -i references/ref.mkv -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1,fps=24" -c:v libx264 -crf 18 -c:a aac references/ref-fit-5s.mp4
```

If the model wants no audio stream at all, drop it (`-an`); muting with a silent track is not the same.

Pass the local path in the endpoint's real video field: `media_generate.video` fills single-string fields
(`video_url`, …); array fields (`video_urls`, `reference_video_urls`) go inside `input` — local paths there
upload automatically. `media_estimate` checks the request before you pay. Never send a YouTube page URL as
if it were a downloadable asset, never invent a universal `video_url` field, and don't claim the model
"used" the reference just because the upload succeeded — check the take.
