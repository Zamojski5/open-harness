# Optional local face-identity signal for real-person cast cards (opt-in, see likeness.ts).
# usage: python3 face_embed.py <ref1> [<ref2> ...] -- <candidate>
# env: OH_FACE_EMBED_MODEL (ArcFace-style ONNX, 112x112 RGB input, (x-127.5)/128, 512-d output)
#      OH_FACE_DETECT_MODEL (UltraFace-RFB-320 style ONNX: input 320x240, outputs scores[1,N,2], boxes[1,N,4] normalised)
# Prints JSON {"cosine": max over ref faces, "faces": {"refs": n, "candidate": n}} or {"error": "..."}.
import json, os, sys

def main():
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except Exception as e:
        return {"error": f"missing python module: {e}"}
    emb_path, det_path = os.environ.get("OH_FACE_EMBED_MODEL"), os.environ.get("OH_FACE_DETECT_MODEL")
    if not emb_path or not det_path or not os.path.exists(emb_path) or not os.path.exists(det_path):
        return {"error": "OH_FACE_EMBED_MODEL and OH_FACE_DETECT_MODEL must point to existing .onnx files"}
    args = sys.argv[1:]
    i = args.index("--")
    refs, cand = args[:i], args[i + 1]
    emb = ort.InferenceSession(emb_path)
    det = ort.InferenceSession(det_path)

    def faces(path):
        img = Image.open(path).convert("RGB")
        w, h = img.size
        x = np.asarray(img.resize((320, 240)), dtype=np.float32)
        x = ((x - 127.0) / 128.0).transpose(2, 0, 1)[None]
        scores, boxes = det.run(None, {det.get_inputs()[0].name: x})
        s, b = scores[0][:, 1], boxes[0]
        order = [k for k in np.argsort(-s) if s[k] > 0.7][:20]
        keep = []
        for k in order:  # greedy NMS
            if all(iou(b[k], b[j]) < 0.3 for j in keep):
                keep.append(k)
        out = []
        for k in keep[:3]:
            x1, y1, x2, y2 = b[k]
            pad = 0.1 * max(x2 - x1, y2 - y1)
            box = (max(0, (x1 - pad) * w), max(0, (y1 - pad) * h), min(w, (x2 + pad) * w), min(h, (y2 + pad) * h))
            crop = img.crop(box).resize((112, 112))
            a = ((np.asarray(crop, dtype=np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
            v = emb.run(None, {emb.get_inputs()[0].name: a})[0][0]
            out.append(v / (np.linalg.norm(v) + 1e-9))
        return out

    def iou(a, b):
        ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)

    rf = [v for r in refs for v in faces(r)]
    cf = faces(cand)
    if not rf or not cf:
        return {"error": f"no face found ({len(rf)} in refs, {len(cf)} in candidate)"}
    return {"cosine": round(float(max(float(a @ c) for a in rf for c in cf)), 3), "faces": {"refs": len(rf), "candidate": len(cf)}}

try:
    print(json.dumps(main()))
except Exception as e:
    print(json.dumps({"error": str(e)[:200]}))
