#!/usr/bin/env python3
"""Prepare an ordered room capture for VGGT reconstruction.

  python3 prepare_capture.py --project room-project --sources capture-sources.json
  python3 prepare_capture.py --project room-project --images a.jpg b.jpg c.jpg

capture-sources.json: [{"path": "...", "seconds": 1.6?, "video": "phone.mp4"?, "room": "kitchen"?}, ...]
(paths relative to that JSON file; order = reconstruction order).

Creates a NEW project folder (refuses an existing one) with:
  sources/            untouched copies of every frame (and each source video, once)
  model-inputs/       frame-0001.png ... EXIF-upright, letterboxed onto a 518x518 canvas
  capture.json        order, hashes, original size, EXIF orientation, content rectangle on the canvas,
                      source video + timestamp + room label (labels are bookkeeping, not alignment)
  request.json        a media_generate request for fal-ai/vggt-1b listing the prepared frames in order
Needs Pillow. No network.
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

CANVAS = 518


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sources")
    src.add_argument("--images", nargs="+")
    a = ap.parse_args()

    if a.sources:
        base = Path(a.sources).resolve().parent
        records = json.loads(Path(a.sources).read_text(encoding="utf-8"))
    else:
        base = Path.cwd()
        records = [{"path": p} for p in a.images]
    if not isinstance(records, list) or not 2 <= len(records) <= 48:
        sys.exit("Give 2-48 overlapping views, in order.")
    project = Path(a.project).resolve()
    if project.exists():
        sys.exit(f"{project} exists; prepare into a new folder (changed input order or content = new project).")

    (project / "sources" / "videos").mkdir(parents=True)
    (project / "model-inputs").mkdir()
    frames, videos = [], {}
    for n, rec in enumerate(records, 1):
        if not isinstance(rec, dict) or not rec.get("path"):
            shutil.rmtree(project)
            sys.exit(f"record {n} has no path")
        source = (base / rec["path"]).resolve()
        if not source.is_file():
            shutil.rmtree(project)
            sys.exit(f"missing frame: {source}")
        fid = f"frame-{n:04d}"
        kept = project / "sources" / f"{fid}{source.suffix.lower()}"
        shutil.copy2(source, kept)
        with Image.open(kept) as im:
            exif = im.getexif().get(274, 1)
            original = im.size
            up = ImageOps.exif_transpose(im).convert("RGB")
        scale = CANVAS / max(up.size)
        w, h = max(1, round(up.width * scale)), max(1, round(up.height * scale))
        left, top = (CANVAS - w) // 2, (CANVAS - h) // 2
        canvas = Image.new("RGB", (CANVAS, CANVAS))
        canvas.paste(up.resize((w, h), Image.LANCZOS), (left, top))
        prepared = project / "model-inputs" / f"{fid}.png"
        canvas.save(prepared)
        entry = {"id": fid, "image": str(prepared.relative_to(project)), "imageSha256": sha256(prepared),
                 "source": str(kept.relative_to(project)), "sourceSha256": sha256(kept),
                 "originalSize": list(original), "exifOrientation": exif,
                 "content": [left, top, w, h]}
        if rec.get("video"):
            video = (base / rec["video"]).resolve()
            if str(video) not in videos and video.is_file():
                dest = project / "sources" / "videos" / video.name
                shutil.copy2(video, dest)
                videos[str(video)] = str(dest.relative_to(project))
            entry["video"] = videos.get(str(video), rec["video"])
            entry["seconds"] = rec.get("seconds")
        if rec.get("room"):
            entry["room"] = rec["room"]
        frames.append(entry)

    (project / "capture.json").write_text(json.dumps({"canvas": CANVAS, "frames": frames}, indent=2) + "\n")
    request = {"model": "fal-ai/vggt-1b", "route": "exact", "title": "room-reconstruction",
               "references": [str(project / f["image"]) for f in frames],
               "input": {"export_prediction_data": True, "export_depth_maps": True,
                         "export_point_cloud": True, "array_encoding": "base64"}}
    (project / "request.json").write_text(json.dumps(request, indent=2) + "\n")
    print(json.dumps({"project": str(project), "frames": len(frames), "request": str(project / "request.json")}))


if __name__ == "__main__":
    main()
