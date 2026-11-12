#!/usr/bin/env python3
"""Static sanity check for an FCPXML file or .fcpxmld bundle before handing it to Final Cut Pro.

Checks: XML parses with an <fcpxml> root, resource ids are unique, every ref=/format= points at a
resource, time attributes use FCPXML rational seconds ("1001/24000s", "5s"), and local media files
named by <asset src> / <media-rep src> exist (relative URLs resolve against the document folder).
It does NOT validate against Apple's DTD and cannot prove Final Cut will import the file.

Usage: python3 fcpxml_check.py /abs/cut.fcpxml   (or /abs/cut.fcpxmld)
Exit: 0 clean, 1 problems found, 2 unreadable input. Prints a JSON report.
"""
import json
import re
import sys
from fractions import Fraction
from pathlib import Path
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

TIME_ATTRS = ("offset", "start", "duration", "frameDuration", "tcStart")
RATIONAL = re.compile(r"^-?\d+(/\d+)?s$")


def to_local_path(url: str, base: Path):
    parts = urlsplit(url)
    if parts.scheme not in ("", "file") or parts.netloc not in ("", "localhost"):
        return None  # remote or unknown scheme: not checked
    p = Path(unquote(parts.path))
    return p if p.is_absolute() else (base / p)


def check(doc: Path) -> dict:
    raw = doc.read_bytes()
    if b"<!ENTITY" in raw.upper():
        raise ValueError("refusing XML with entity declarations")
    root = ET.fromstring(raw)
    if root.tag != "fcpxml":
        raise ValueError(f"root element is <{root.tag}>, expected <fcpxml>")

    problems, ids = [], {}
    for res in root.iterfind("./resources/*"):
        rid = res.get("id")
        if not rid:
            continue
        if rid in ids:
            problems.append({"problem": "duplicate id", "id": rid})
        ids[rid] = res.tag
    style_ids = {e.get("id") for e in root.iter("text-style-def") if e.get("id")}

    for el in root.iter():
        for attr in ("ref", "format"):
            val = el.get(attr)
            if not val:
                continue
            known = style_ids if (el.tag == "text-style" and attr == "ref") else ids
            if val not in known:
                problems.append({"problem": "unknown reference", "element": el.tag, "attr": attr, "value": val})
        for attr in TIME_ATTRS:
            val = el.get(attr)
            if val is None:
                continue
            bad = not RATIONAL.match(val)
            if not bad:
                try:
                    t = Fraction(val[:-1])
                    bad = (attr == "duration" and t < 0) or (attr == "frameDuration" and t <= 0)
                except (ValueError, ZeroDivisionError):
                    bad = True
            if bad:
                problems.append({"problem": "bad time", "element": el.tag, "attr": attr, "value": val})

    media, missing, unchecked = [], [], []
    for asset in root.iterfind("./resources/asset"):
        sources = ([asset] if asset.get("src") else []) + asset.findall("media-rep")
        if not sources:
            problems.append({"problem": "asset has no media", "id": asset.get("id")})
        for s in sources:
            url = s.get("src", "")
            path = to_local_path(url, doc.parent)
            entry = {"asset": asset.get("id"), "kind": s.get("kind", "src"), "url": url}
            if path is None:
                unchecked.append(entry)
            elif not path.is_file():
                missing.append(entry)
            media.append(entry)

    return {"file": str(doc), "version": root.get("version"), "problems": problems,
            "media_count": len(media), "missing_media": missing, "unchecked_media": unchecked,
            "note": "static check only; confirm the import inside Final Cut Pro"}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1]).expanduser().resolve()
    if target.is_dir():
        target = target / "Info.fcpxml"
    try:
        report = check(target)
    except (OSError, ValueError, ET.ParseError) as exc:
        print(json.dumps({"file": str(target), "error": str(exc)}))
        return 2
    print(json.dumps(report, indent=2))
    return 1 if report["problems"] or report["missing_media"] else 0


if __name__ == "__main__":
    sys.exit(main())
