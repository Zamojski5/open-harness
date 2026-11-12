---
name: obs
description: Control OBS Studio over obs-websocket v5 — switch scenes, start/stop recording or streaming, toggle sources, set text, take screenshots. Use for screen recordings, tutorials, live-stream setups or capturing a demo of an app the agent drives.
---

# OBS Studio

Recording discipline (permissions, exact sources, verifying system audio, take folders, facecam styling, edit timing): `screen-capture`.

Status: **untested here** (OBS not installed).

## Install / enable

- `brew install --cask obs` (consent first). obs-websocket v5 is built into OBS 28+.
- Tools → WebSocket Server Settings → Enable, port **4455**, set/show password. OBS must be running (GUI). macOS needs Screen Recording permission for display capture — the user grants it.

## Protocol essentials (v5)

1. Connect `ws://localhost:4455`. Server sends **Hello** (op 0) with `authentication: {challenge, salt}` if a password is set.
2. Auth string: `secret = base64(sha256(password + salt))`, then `auth = base64(sha256(secret + challenge))`.
3. Send **Identify** (op 1): `{"op":1,"d":{"rpcVersion":1,"authentication":auth}}` → **Identified** (op 2).
4. Requests (op 6): `{"op":6,"d":{"requestType":"StartRecord","requestId":"r1","requestData":{}}}` → response op 7.

## Minimal client (Python, `pip install obsws-python` or raw websockets)

```python
import obsws_python as obs  # untested
cl = obs.ReqClient(host="localhost", port=4455, password="…", timeout=5)
print(cl.get_version().obs_version)
cl.set_current_program_scene("Demo")
cl.set_input_settings("Title", {"text": "Step 2: Render"}, True)
cl.start_record(); __import__("time").sleep(10); res = cl.stop_record()
print(res.output_path)
cl.save_source_screenshot("Demo", "png", "/abs/shot.png", 1920, 1080, -1)
```

Useful requests: `GetSceneList`, `SetCurrentProgramScene`, `GetInputList`, `SetSceneItemEnabled`, `StartRecord`/`StopRecord`, `StartStream`, `SaveSourceScreenshot`, `SetRecordDirectory`.

## Recording settings to recommend

1080p or 1440p canvas, 30/60 fps, MKV or fragmented MP4 (survives crashes), CQP/CRF ~18-20 for tutorials. Remux MKV → MP4: `ffmpeg -i in.mkv -c copy out.mp4`.

## Limits

No built-in OBS MCP tool; use a small Python client per job.

## Pitfalls

- Never store the password in project files; ask the user or read from env.
- Without OBS: macOS `screencapture -v` or ffmpeg `avfoundation` input can record screen (needs the same permission).
- Review recordings with `media_frames`.
