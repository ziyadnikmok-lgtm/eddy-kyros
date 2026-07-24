"""Match poses to video prompts by what the images LOOK like, not by their bytes.

An earlier attempt compared image hashes for exact equality, got zero matches, and concluded the
sets were unrelated. That was wrong: the pose images were re-exported and re-encoded, so they are
byte-different while showing the same shot. Text matching was tried next and produced nonsense,
because a pose describes a static position while a video title describes movement.

Comparing what the pictures actually depict is the approach that fits the data.

Two perceptual hashes are used together because each fails differently:
  dHash  tracks horizontal gradients — robust to brightness and re-encoding
  aHash  tracks overall light and dark regions — robust to small crops
Agreement between them is much harder to reach by accident than either alone.

Where a pose and a video entry are visually the same shot, the user's own image and pose prompt
win — they are the source of truth — and the video prompt is attached to that card.
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

# A Hamming distance over a 64-bit hash. 0 is identical; ~10 is "clearly the same picture";
# beyond ~14 the pairs stop being the same shot. Both hashes must agree, which is the real filter.
DHASH_MAX = 12
AHASH_MAX = 12


def load(data_url):
    try:
        _, _, b64 = str(data_url or "").partition(",")
        if not b64:
            return None
        im = Image.open(io.BytesIO(base64.b64decode(b64)))
        im.load()
        return im.convert("L")
    except Exception:
        return None


def dhash(im, size=8):
    """Each bit says whether a pixel is brighter than the one to its right."""
    small = np.asarray(im.resize((size + 1, size), Image.LANCZOS), dtype=np.int16)
    return np.packbits(small[:, 1:] > small[:, :-1]).tobytes()


def ahash(im, size=8):
    """Each bit says whether a pixel is brighter than the image's mean."""
    small = np.asarray(im.resize((size, size), Image.LANCZOS), dtype=np.int16)
    return np.packbits(small > small.mean()).tobytes()


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
    vids = [v | {"image": row.get("image", "")}
            for row in json.loads(VIDEOS.read_text(encoding="utf-8"))
            for v in row.get("variations", [])]

    print(f"hashing {len(poses)} poses and {len(vids)} video entries...")

    pose_h = []
    for p in poses:
        im = load(p.get("image"))
        pose_h.append((dhash(im), ahash(im)) if im else None)

    vid_h = []
    for v in vids:
        im = load(v.get("image"))
        vid_h.append((dhash(im), ahash(im)) if im else None)

    pairs = []
    for i, ph in enumerate(pose_h):
        if not ph:
            continue
        best = None
        for j, vh in enumerate(vid_h):
            if not vh:
                continue
            dd, da = hamming(ph[0], vh[0]), hamming(ph[1], vh[1])
            # Both must agree — a single hash agreeing alone is usually coincidence.
            if dd <= DHASH_MAX and da <= AHASH_MAX:
                total = dd + da
                if best is None or total < best[0]:
                    best = (total, j, dd, da)
        if best:
            pairs.append((best[0], i, best[1], best[2], best[3]))

    pairs.sort()
    print(f"\nvisually matched: {len(pairs)} of {len(poses)} poses\n")
    for total, i, j, dd, da in pairs:
        print(f"  d={dd:>2} a={da:>2}  POSE: {pose_text(poses[i].get('prompt'))[:56]}")
        print(f"              VID : {str(vids[j].get('title') or '')[:56]}")

    matched_poses = {i for _, i, _, _, _ in pairs}
    print(f"\nunmatched poses: {len(poses) - len(matched_poses)}")


if __name__ == "__main__":
    main()
