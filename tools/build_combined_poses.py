"""Build ONE import file holding every pose and every video prompt.

The two collections came from different places and describe different halves of the same thing:
a pose card says how she is positioned, a video entry says how she moves. Neither is complete on
its own, and matching them automatically produced confident-looking nonsense — a "standing on
one leg" pose paired to an "arched doggy" motion — because the vocabularies barely overlap.

So nothing is matched. Everything is put in one collection, each entry keeping whatever it
already has:

  from the pose export   image + posePrompt          (videoPrompt left empty)
  from the video sheet   image + videoPrompt         (posePrompt left empty)

The gaps are then fillable in the app: an entry with an image but no pose prompt gets one from
"Describe with AI", which reads the image. That is the user's own workflow, not a guess made
here.

True duplicates in the video set are dropped — same prompt AND same image. Entries sharing a
prompt but carrying DIFFERENT images are kept: those are deliberate A/B pairs, two starting
frames for one motion.

Output: Downloads/eddy-poses-combined.json — import into the Pose tab.
"""
import base64
import hashlib
import io
import json
import pathlib
import re

from PIL import Image

# The video images were already downscaled when they came out of the spreadsheet; the pose
# images are full size, which is what took this file to 24 MB. These are reference thumbnails
# sitting beside a prompt, never output, so matching them to the same 1024px ceiling costs
# nothing visible and roughly halves what has to fit in browser storage.
MAX_EDGE = 1024
JPEG_QUALITY = 82


def shrink(data_url):
    """Downscale a data URL, returning it unchanged if it cannot be read."""
    try:
        head, _, b64 = str(data_url or "").partition(",")
        if not b64:
            return data_url
        im = Image.open(io.BytesIO(base64.b64decode(b64)))
        im.load()
        if max(im.size) <= MAX_EDGE and "jpeg" in head:
            return data_url
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        # An unreadable image must not cost the card its prompt.
        return data_url

POSES = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-posess.json")
VIDEOS = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts-for-pose-tab.json")


def pose_text(raw):
    """A pose is stored as a JSON block; only pose_action.description describes the shot."""
    s = str(raw or "").strip()
    if not s.startswith("{"):
        return s
    try:
        return json.loads(s).get("pose_action", {}).get("description", "")
    except Exception:
        m = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', s)
        return m.group(1) if m else ""


def sig(text):
    return hashlib.sha1(str(text or "").encode()).hexdigest()


def title_from(text, fallback):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return (t[:70] or fallback)


def main():
    poses = json.loads(POSES.read_text(encoding="utf-8"))
    video_rows = json.loads(VIDEOS.read_text(encoding="utf-8"))

    out = []

    # The user's own poses first, untouched: their prompt and image are the source of truth.
    # This file is a COMPLETE set, so the Pose tab must be cleared before importing or every
    # pose lands twice.
    for p in poses:
        desc = pose_text(p.get("prompt"))
        out.append({
            "title": title_from(desc, "pose"),
            "prompt": p.get("prompt", ""),
            "videoPrompt": "",
            "image": shrink(p.get("image", "")),
            "folder": p.get("folder") or "Poses",
        })

    # Then every video prompt with its own reference image. No pose prompt — that is what
    # Describe with AI is for, and it reads the image rather than guessing from the motion.
    seen = set()
    dropped = 0
    for row in video_rows:
        image = row.get("image", "")
        for v in row.get("variations", []):
            prompt = (v.get("prompt") or "").strip()
            if not prompt:
                continue
            # Same motion AND same frame is a genuine duplicate. Same motion with a different
            # frame is an A/B pair and worth keeping.
            key = (sig(re.sub(r"\s+", " ", prompt.lower())), sig(image))
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
            out.append({
                "title": title_from(v.get("title"), "video prompt"),
                "prompt": "",
                "videoPrompt": prompt,
                "image": image,
                "folder": row.get("folder") or "Video prompts",
            })

    OUT.write_text(json.dumps(out), encoding="utf-8")

    with_pose = sum(1 for e in out if e["prompt"])
    with_video = sum(1 for e in out if e["videoPrompt"])
    with_image = sum(1 for e in out if e["image"])

    print(f"cards to import    : {len(out)}")
    print(f"  your poses       : {len(poses)}")
    print(f"  video prompts    : {len(out) - len(poses)}   ({dropped} exact duplicates dropped)")
    print()
    print(f"have a pose prompt : {with_pose}")
    print(f"have a video prompt: {with_video}")
    print(f"have an image      : {with_image}  <- Describe with AI works on all of these")
    print()
    print(f"folders            : {sorted({e['folder'] for e in out})}")
    print(f"written            : {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
