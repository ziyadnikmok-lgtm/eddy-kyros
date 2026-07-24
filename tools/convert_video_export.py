"""Convert a Video Library export into Pose-tab shape.

The old export predates two fixes and is wrong twice over when imported into the Pose tab:

  - it carries no `title`, so every card lands as "import-56"
  - its `prompt` field holds the VIDEO prompt, which the Pose tab reads as the POSE prompt, so
    the CHARACTERS block appears in the wrong box and the video prompt box is empty

Both are recoverable. The prompt simply moves to `videoPrompt`, and the titles still exist in
the source spreadsheet — matching on prompt text puts each one back.
"""
import json
import pathlib
import re

SRC = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video.json")
SHEET = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-for-pose-tab.json")


def norm(text):
    """Whitespace and case are the only things that differ between the two copies."""
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def main():
    rows = json.loads(SRC.read_text(encoding="utf-8"))

    # Titles live in the spreadsheet extraction, keyed by the prompt they belong to.
    titles = {}
    for row in json.loads(SHEET.read_text(encoding="utf-8")):
        for v in row.get("variations", []):
            key = norm(v.get("prompt"))[:400]
            if key and v.get("title"):
                titles.setdefault(key, v["title"])

    out, named = [], 0
    for i, r in enumerate(rows, 1):
        prompt = str(r.get("prompt") or "").strip()
        if not prompt and not r.get("image"):
            continue
        title = titles.get(norm(prompt)[:400], "")
        if title:
            named += 1
        out.append({
            "title": (title or f"video {i}")[:70],
            "prompt": "",                 # pose prompt stays empty — Describe with AI fills it
            "videoPrompt": prompt,        # where it actually belongs
            "image": r.get("image", ""),
            "folder": r.get("folder") or "Video prompts",
        })

    OUT.write_text(json.dumps(out), encoding="utf-8")
    print(f"cards           : {len(out)}")
    print(f"titles restored : {named} of {len(out)}")
    print(f"video prompt in : videoPrompt  (was landing in the pose prompt box)")
    print(f"pose prompt     : empty on all -> drag an image, or use Describe with AI")
    print(f"written         : {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
