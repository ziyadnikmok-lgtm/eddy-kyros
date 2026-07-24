"""Keep every video prompt, but put the user's own model on the ones whose pose he already has.

The video sheet holds 2-3 motion variations per shot. Those must all survive — they are the
point. What changes is whose picture sits on them: where a video card shows a pose the user
already has in his own collection, that card takes HIS image and HIS pose prompt, and keeps its
own video prompt.

So three video prompts of one pose become three cards, all showing his model, each with a
different motion.

Why his image wins: it is his model rather than the spreadsheet's, and the Pose tab has already
blurred its face — which is why byte-comparison found no matches between the two sets even
though many are the same photograph.

Pairs come from tools/visual_pairs.json, identified by looking at contact sheets of both sets
and then verifying each proposed pair side by side. Perceptual hashing only finds the same
PHOTO; the same POSE in a different shot needs eyes.
"""
import base64
import hashlib
import io
import json
import pathlib
import re

import numpy as np
from PIL import Image

POSES = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-posess.json")
VIDEOS = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
PAIRS = pathlib.Path("tools/visual_pairs.json")
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

    # Drop only true duplicates: same motion AND same frame. Same motion with a different frame
    # is a deliberate A/B pair and is kept.
    seen, unique = set(), []
    for v in vids:
        # Hash the WHOLE image. Slicing the first 200 chars of a data URL compares the base64
        # header, which is near-identical for every JPEG — that silently collapsed 97 prompts to
        # 52 by treating different pictures as the same one.
        key = (re.sub(r"\s+", " ", str(v.get("prompt") or "").lower())[:400],
               hashlib.sha1(str(v.get("image") or "").encode()).hexdigest())
        if not key[0] or key in seen:
            continue
        seen.add(key)
        unique.append(v)
    vids = unique

    pose_im = [load(p.get("image")) for p in poses]
    vid_im = [load(v.get("image")) for v in vids]
    pose_h = [(dhash(i), ahash(i)) if i else None for i in pose_im]
    vid_h = [(dhash(i), ahash(i)) if i else None for i in vid_im]

    # A video card's owner: the pose whose picture it matches. Hash matches first (same photo),
    # then the hand-verified visual pairs (same pose, different photo).
    owner = {}
    for j, vh in enumerate(vid_h):
        if not vh:
            continue
        best = None
        for i, ph in enumerate(pose_h):
            if not ph:
                continue
            dd, da = hamming(ph[0], vh[0]), hamming(ph[1], vh[1])
            if dd <= DHASH_MAX and da <= AHASH_MAX and (best is None or dd + da < best[0]):
                best = (dd + da, i)
        if best:
            owner[j] = best[1]

    # Visual pairs name ONE representative video card each. Everything that looks like that
    # card also belongs to the same pose — which is how all 2-3 motion variations of a shot
    # inherit the user's model, not just the one that was named.
    # Visual pairs name ONE representative video card by title — a stable handle, unlike a
    # position in a list whose length depends on the dedup rules in force at the time.
    # Everything that LOOKS like that card belongs to the same pose too, which is how all 2-3
    # motion variations of a shot inherit the user's model rather than only the named one.
    pairs = json.loads(PAIRS.read_text(encoding="utf-8"))["pairs"]
    by_title = {}
    for j, v in enumerate(vids):
        by_title.setdefault((v.get("title") or "")[:90], j)

    for pr in pairs:
        idx = by_title.get(pr.get("videoTitle", ""))
        if idx is None or not vid_h[idx]:
            continue
        pose_i = pr["mine"] - 1
        for j, vh in enumerate(vid_h):
            if j in owner or not vh:
                continue
            # 8 bits is looser than the same-photo threshold on purpose: these are other shots
            # from the same setup, so they differ more than a re-encode but far less than an
            # unrelated pose.
            if hamming(vid_h[idx][0], vh[0]) <= 8 and hamming(vid_h[idx][1], vh[1]) <= 8:
                owner[j] = pose_i
        owner[idx] = pose_i

    shrunk = {}
    out = []
    swapped = 0
    for j, v in enumerate(vids):
        i = owner.get(j)
        if i is not None:
            if i not in shrunk:
                shrunk[i] = shrink(poses[i].get("image", ""))
            out.append({
                "title": (v.get("title") or "video prompt")[:70],
                "prompt": poses[i].get("prompt", ""),     # HIS pose prompt
                "videoPrompt": v.get("prompt", ""),       # THEIR motion
                "image": shrunk[i],                       # HIS model, face already blurred
                "folder": "Matched",
            })
            swapped += 1
        else:
            out.append({
                "title": (v.get("title") or "video prompt")[:70],
                "prompt": "",
                "videoPrompt": v.get("prompt", ""),
                "image": v.get("image", ""),
                "folder": "Needs pose",
            })

    # His poses that no video prompt covers stay as their own cards — nothing is lost.
    covered = set(owner.values())
    for i, p in enumerate(poses):
        if i in covered:
            continue
        out.append({
            "title": (pose_text(p.get("prompt"))[:70] or "pose"),
            "prompt": p.get("prompt", ""),
            "videoPrompt": "",
            "image": shrink(p.get("image", "")),
            "folder": "My poses",
        })

    OUT.write_text(json.dumps(out), encoding="utf-8")

    print(f"video prompt cards        : {len(vids)}   (all kept)")
    print(f"  now showing YOUR model  : {swapped}")
    print(f"  still their model       : {len(vids) - swapped}  -> Describe with AI for the pose prompt")
    print(f"your poses used           : {len(covered)} of {len(poses)}")
    print(f"your poses added separately: {len(poses) - len(covered)}")
    print(f"TOTAL CARDS               : {len(out)}")
    print(f"written                   : {OUT}  ({OUT.stat().st_size/1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
