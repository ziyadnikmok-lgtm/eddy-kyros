"""Strip only the TRUE duplicates from the video-prompt import file.

The Updated sheet repeats every prompt from Proven, but 21 of those pairs carry a DIFFERENT
reference image — same motion, two starting frames. That is deliberate and worth keeping, so a
naive dedupe by prompt would throw away half the useful set.

Only a card whose prompt AND image both already appear is removed.

    python tools/dedupe_video_prompts.py            report only, changes nothing
    python tools/dedupe_video_prompts.py --write    write the cleaned file
"""
import hashlib
import json
import pathlib
import re
import sys

SRC = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts-clean.json")


def norm(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def sig(image):
    return hashlib.sha1((image or "").encode()).hexdigest()


def main():
    write = "--write" in sys.argv
    rows = json.loads(SRC.read_text(encoding="utf-8"))

    seen = set()
    kept_rows = []
    dropped = []

    for row in rows:
        image_sig = sig(row.get("image"))
        kept_vars = []
        for var in row.get("variations", []):
            key = (norm(var.get("prompt")), image_sig)
            if key in seen:
                dropped.append({"folder": row.get("folder"), "title": var.get("title", "")[:70]})
                continue
            seen.add(key)
            kept_vars.append(var)
        if kept_vars:
            kept_rows.append({**row, "variations": kept_vars})

    before = sum(len(r.get("variations", [])) for r in rows)
    after = sum(len(r["variations"]) for r in kept_rows)

    print(f"cards before : {before}")
    print(f"cards after  : {after}")
    print(f"removed      : {len(dropped)}  (same prompt AND same image)")
    if dropped:
        print()
        print("dropped:")
        for d in dropped:
            print(f"   [{d['folder']}] {d['title']}")

    if not write:
        print()
        print("report only — re-run with --write to save the cleaned file")
        return

    OUT.write_text(json.dumps(kept_rows), encoding="utf-8")
    print()
    print(f"written: {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
