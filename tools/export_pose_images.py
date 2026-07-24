"""Write the user's 36 pose images to a folder so they can be dragged onto cards.

Named by the pose they show, not by index — the point is to spot the right one at a glance in
Explorer while looking at a card that needs it.

Writes the image exactly as stored, which is already face-blurred. Dropping one onto a card
re-blurs harmlessly, and the pose description is generated from the picture before that step.
"""
import base64
import io
import json
import pathlib
import re

from PIL import Image

SRC = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-posess.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\my-36-poses")


def pose_text(raw):
    """A pose is stored as a JSON block; only pose_action.description names the shot."""
    s = str(raw or "").strip()
    if not s.startswith("{"):
        return s
    try:
        return json.loads(s).get("pose_action", {}).get("description", "")
    except Exception:
        # The source template has a missing comma and a trailing comma, so JSON.parse genuinely
        # fails on real rows — pull the field out with a pattern instead.
        m = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', s)
        return m.group(1) if m else ""


def slugify(text, fallback="pose"):
    s = re.sub(r"[^\w ]+", "", str(text or "")).strip()
    s = re.sub(r"\s+", "-", s)[:60].strip("-").lower()
    return s or fallback


def main():
    src = json.loads(SRC.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.jpg"):
        old.unlink()

    written = 0
    for i, p in enumerate(src, 1):
        _, _, b64 = str(p.get("image") or "").partition(",")
        if not b64:
            continue
        try:
            im = Image.open(io.BytesIO(base64.b64decode(b64)))
            im.load()
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
        except Exception:
            continue
        im.save(OUT / f"M{i:02d}-{slugify(pose_text(p.get('prompt')))}.jpg", quality=92)
        written += 1

    print(f"written: {written} images -> {OUT}")
    for f in sorted(OUT.glob("*.jpg"))[:10]:
        print("   ", f.name)


if __name__ == "__main__":
    main()
