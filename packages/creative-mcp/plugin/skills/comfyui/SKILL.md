---
name: comfyui
description: Run local Stable Diffusion / Flux / video model workflows through ComfyUI's HTTP API — queue an API-format workflow JSON, set prompt/seed/size, poll history and fetch images. Use when the user has ComfyUI running locally (GPU) and wants local generation instead of paid APIs, or provides a ComfyUI workflow.
---

# ComfyUI

Status: **untested here** (ComfyUI not installed). The user must have models downloaded; a Mac without a strong Apple Silicon GPU is slow.

## Clarify up front (skip what the request or files settle)

- Which graph — a workflow file, one of ComfyUI's templates, or whatever is loaded in the UI now?
- Is the server up, and is it the **Desktop** app or a git/portable install?
- Local only, or are paid cloud models (`media_generate`, `make-image`/`make-ai-video`) acceptable?

## Find the server

Unauthenticated HTTP on 127.0.0.1. Manual/portable installs default to **8188**; the Desktop app chooses its own (8000 is common). Find it by asking `/system_stats`:

```bash
for p in 8188 8000; do curl -s -m 2 "http://127.0.0.1:$p/system_stats" >/dev/null && echo "ComfyUI on $p"; done
```

## Install (consent first)

Desktop app: download from comfy.org, or `git clone https://github.com/comfyanonymous/ComfyUI && cd ComfyUI && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python main.py`. Models go in `models/checkpoints`, `models/loras`, etc. — mind each model's licence (some are non-commercial).

## Workflow JSON: use the API format

In the ComfyUI UI enable dev mode options, then **Workflow → Export (API)** / "Save (API Format)". The normal UI-format `.json` (with `nodes`/`links` arrays) is **not** accepted by `/prompt` — it fails with a "has no class_type" error. API format is a dict of node-id → `{class_type, inputs}`; links are `["<node-id>", <output-index>]`. If the user only has a UI-format file, `comfy run --workflow file.json` from **comfy-cli** (`pip install comfy-cli`, consent first) converts it.

Before editing a workflow read `GET /object_info`: checkpoint/LoRA/VAE names must equal an entry in its lists character for character, and `missing_node_type` signals an uninstalled custom node pack. Installing node packs or downloading models needs the user's OK.

## Queue and fetch (Python stdlib)

```python
import json, time, urllib.request, urllib.parse, uuid  # untested
BASE = "http://127.0.0.1:8188"
wf = json.load(open("workflows/poster_api.json"))
# Find nodes by class_type instead of hard-coding ids:
for nid, n in wf.items():
    if n["class_type"] == "CLIPTextEncode" and "negative" not in n.get("_meta", {}).get("title", "").lower():
        n["inputs"]["text"] = "lighthouse on a cliff at dusk, 85mm, rim light, no text"
    if n["class_type"] == "KSampler":
        n["inputs"]["seed"] = 1234
    if n["class_type"] == "EmptyLatentImage":
        n["inputs"].update(width=896, height=1152, batch_size=2)
req = urllib.request.Request(f"{BASE}/prompt", json.dumps({"prompt": wf, "client_id": str(uuid.uuid4())}).encode(),
                             {"Content-Type": "application/json"})
pid = json.load(urllib.request.urlopen(req))["prompt_id"]
while True:
    hist = json.load(urllib.request.urlopen(f"{BASE}/history/{pid}"))
    if pid in hist: break
    time.sleep(2)
for node in hist[pid]["outputs"].values():
    for im in node.get("images", []):
        q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
        open(f"renders/{im['filename']}", "wb").write(urllib.request.urlopen(f"{BASE}/view?{q}").read())
```

Other endpoints: `GET /object_info` (all node types and inputs), `POST /upload/image` (multipart, for img2img/ControlNet inputs), `GET /queue`, `POST /interrupt`, websocket `/ws?clientId=` for progress.

## Craft notes

Same prompt structure and "no text in the image" rule as `make-image`. Sizes: SDXL/Flux like ~1 MP (1024×1024, 896×1152, 1344×768). Use a fixed seed when iterating; change one parameter per take; never overwrite outputs.

## Pitfalls

- 400 error with `node_errors` → missing model file or custom node; check `/object_info`.
- Re-queueing an identical graph hits ComfyUI's cache and produces nothing new; vary the seed (or another input) for each take.
- Results are written to ComfyUI's own `output/` directory. Download them via `/view` into `takes/` and present those copies.
- Custom nodes run arbitrary Python — only install ones the user trusts.
