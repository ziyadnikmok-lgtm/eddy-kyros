"""Build the final Pose-tab import: your poses, with matched video prompts attached.

Matching is VISUAL, not textual. Byte comparison found nothing because the Pose tab auto-blurs
faces, so the same photo is byte-different between the two collections — verified by rendering a
matched pair side by side: identical shot, one face blurred. Text matching was worse, pairing a
"standing on one leg" pose to an "arched doggy" motion, because a pose describes a position and
a video title describes movement.

Two perceptual hashes must BOTH agree within 3 bits. At that threshold the pairs are the same
photograph; loosening it to 7 immediately pairs a kneeling pose with a shot of a hand pouring
milk. A wrong pairing sends the wrong motion into a generation that costs money, so the
threshold errs tight and leaves the rest for the user.

Where a pose matches, the user's own image and pose prompt win — theirs is the source of truth,
and its face is already blurred, which the spreadsheet copy is not.
"""
import base64
import io
import json
import pathlib
import re

import numpy as np
from PIL import Image

POSES = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-posess.json")
VIDEOS = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-poses-final.json")

DHASH_MAX = 3
AHASH_MAX = 3
MAX_EDGE = 1024
JPEG_QUALITY = 82


def load(data_url):
    try:
        _, _, b64 = str(data_url or "").partition(",")
        if not b64:
            return None
        im = Image.open(io.BytesIO(base64.b64decode(b64)))
        im.load()
        return im
    except Exception:
        return None


def shrink(data_url):
    """Reference thumbnails, never output — a 1024px ceiling halves what browser storage holds."""
    im = load(data_url)
    if im is None:
        return data_url
    try:
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if max(im.size) > MAX_EDGE:
            im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return data_url


def dhash(im, size=8):
    a = np.asarray(im.convert("L").resize((size + 1, size), Image.LANCZOS), dtype=np.int16)
    return np.packbits(a[:, 1:] > a[:, :-1]).tobytes()


def ahash(im, size=8):
    a = np.asarray(im.convert("L").resize((size, size), Image.LANCZOS), dtype=np.int16)
    return np.packbits(a > a.mean()).tobytes()


def hamming(a, b):
    return sum(bin(x ^ y).count("1") for x, y in zip(a, b))


def pose_text(raw):
    s = str(raw or "").strip()
    if not s.startswith("{"):
        return s
    try:
        return json.loads(s).get("pose_action", {}).get("description", "")
    except Exception:
        m = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', s)
        return m.group(1) if m else ""


def main():
    poses = json.loads(POSES.read_text(encoding="utf-8"))
    vids = [dict(v, image=row.get("image", ""))
            for row in json.loads(VIDEOS.read_text(encoding="utf-8"))
            for v in row.get("variations", [])]

    pose_im = [load(p.get("image")) for p in poses]
    vid_im = [load(v.get("image")) for v in vids]
    pose_h = [(dhash(im), ahash(im)) if im else None for im in pose_im]
    vid_h = [(dhash(im), ahash(im)) if im else None for im in vid_im]

    # Best video per pose, and never the same video twice — one motion belongs to one shot.
    candidates = []
    for i, ph in enumerate(pose_h):
        if not ph:
            continue
        for j, vh in enumerate(vid_h):
            if not vh:
                continue
            dd, da = hamming(ph[0], vh[0]), hamming(ph[1], vh[1])
            if dd <= DHASH_MAX and da <= AHASH_MAX:
                candidates.append((dd + da, i, j))
    candidates.sort()

    by_pose, used = {}, set()
    for _, i, j in candidates:
        if i in by_pose or j in used:
            continue
        by_pose[i], _ = j, used.add(j)

    out = []
    for i, p in enumerate(poses):
        j = by_pose.get(i)
        entry = {
            "title": (pose_text(p.get("prompt"))[:70] or "pose"),
            "prompt": p.get("prompt", ""),          # the user's pose prompt, untouched
            "videoPrompt": "",
            "image": shrink(p.get("image", "")),    # the user's image, face already blurred
            "folder": p.get("folder") or "Poses",
        }
        if j is not None:
            entry["videoPrompt"] = vids[j].get("prompt", "")
            entry["title"] = (vids[j].get("title") or entry["title"])[:70]
        out.append(entry)

    # Video entries with no visual twin keep their own image; their pose prompt stays empty for
    # Describe with AI, which reads the picture.
    seen = set()
    for j, v in enumerate(vids):
        if j in used:
            continue
        key = re.sub(r"\s+", " ", str(v.get("prompt") or "").lower())[:400]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "title": (v.get("title") or "video prompt")[:70],
            "prompt": "",
            "videoPrompt": v.get("prompt", ""),
            "image": v.get("image", ""),
            "folder": "Video prompts",
        })

    OUT.write_text(json.dumps(out), encoding="utf-8")

    print(f"visually matched : {len(by_pose)} of {len(poses)} poses")
    for i, j in sorted(by_pose.items()):
        print(f"   {pose_text(poses[i].get('prompt'))[:44]:<46} <- {str(vids[j].get('title'))[:44]}")
    print()
    print(f"cards to import  : {len(out)}")
    print(f"  your poses     : {len(poses)}  ({len(by_pose)} with a video prompt attached)")
    print(f"  video-only     : {len(out) - len(poses)}  (pose prompt empty -> Describe with AI)")
    print(f"written          : {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
