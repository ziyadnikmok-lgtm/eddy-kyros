"""Pull the video-prompt sheets out of X Automation Prep.xlsx into Eddy's import JSON.

The images are PASTED INTO cells, so they exist only as drawing anchors inside the .xlsx — a
CSV export of this sheet has no pictures at all. openpyxl exposes the anchor's row, which is how
each picture gets matched to the prompts beside it.

Layout, repeated across both sheets: one image column, then (Video Idea, Video Prompt variation
N) pairs. Each pair becomes its own entry sharing that row's image, which is what the Video
Library importer expands into one card per variation.

Output: Downloads/eddy-video-prompts.json  ->  drop into Video Library -> Import from a sheet.
"""
import base64
import io
import json
import pathlib

import openpyxl
from PIL import Image

# Full-resolution stills came to 192 MB across 50 rows, which browser storage rejects outright.
# These are reference thumbnails sitting beside a prompt — 1024px on the long edge is more than
# enough to recognise the shot, and JPEG at 82 keeps the whole set in a few MB.
MAX_EDGE = 1024
JPEG_QUALITY = 82

SRC = pathlib.Path(r"C:\Users\asusg\Downloads\X Automation Prep.xlsx")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")

MIME = {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg", "gif": "image/gif"}


def images_by_row(ws):
    """Map row number -> data URL, keeping the LEFTMOST image when a row holds several."""
    found = {}
    for img in getattr(ws, "_images", []):
        anchor = img.anchor
        frm = getattr(anchor, "_from", None)
        if frm is None:
            continue
        row = frm.row + 1          # openpyxl anchors are 0-based
        col = frm.col
        try:
            blob = img._data()
        except Exception:
            continue
        try:
            im = Image.open(io.BytesIO(blob))
            im.load()
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            if max(im.size) > MAX_EDGE:
                im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        except Exception:
            # An unreadable picture must not cost the row its prompts.
            continue
        # The row's own picture is the left-hand one; anything further right belongs to another
        # column's variant (Updated has both a Seedream and a Nano picture per row).
        if row not in found or col < found[row][0]:
            found[row] = (col, url)
    return {r: u for r, (_, u) in found.items()}


def pairs_from_header(ws):
    """[(idea_col, prompt_col)] read off row 1, matching each prompt to the label on its left."""
    header = {c.column: (c.value or "").strip().lower() for c in ws[1] if isinstance(c.value, str)}
    prompt_cols = sorted(c for c, v in header.items() if "prompt variation" in v)
    out = []
    for pc in prompt_cols:
        idea = None
        for c in range(pc - 1, 0, -1):
            v = header.get(c, "")
            if "idea" in v:
                idea = c
                break
            if "prompt" in v:
                break
        out.append((idea, pc))
    return out


def main():
    wb = openpyxl.load_workbook(SRC)
    entries = []

    for sheet in ("Proven", "Updated"):
        if sheet not in wb.sheetnames:
            continue
        ws = wb[sheet]
        imgs = images_by_row(ws)
        pairs = pairs_from_header(ws)
        if not pairs:
            print(f"  {sheet}: no prompt-variation columns, skipped")
            continue

        made = 0
        for row in range(2, ws.max_row + 1):
            variations = []
            for idea_col, prompt_col in pairs:
                prompt = ws.cell(row=row, column=prompt_col).value
                idea = ws.cell(row=row, column=idea_col).value if idea_col else ""
                if not isinstance(prompt, str) or not prompt.strip():
                    continue
                # The idea cell holds the shot title, then a blank line, then the boilerplate
                # "Use the starting image prompt for context" repeated on every row. Only the
                # first line is the real title.
                # Title and prompt stay SEPARATE: the title names the shot, the prompt is the
                # instruction and starts at CHARACTERS:.
                title = ""
                if isinstance(idea, str) and idea.strip():
                    title = idea.strip().splitlines()[0].strip()
                variations.append({"title": title, "prompt": prompt.strip()})
            if not variations:
                continue
            # An anchor can sit a row above or below its logical row, so accept a near miss
            # rather than dropping the picture entirely.
            image = imgs.get(row) or imgs.get(row - 1) or imgs.get(row + 1) or ""
            entries.append({"image": image, "folder": sheet, "variations": variations})
            made += 1
        print(f"  {sheet}: {made} rows, {len(imgs)} images anchored")

    OUT.write_text(json.dumps(entries), encoding="utf-8")
    cards = sum(len(e["variations"]) for e in entries)
    withimg = sum(1 for e in entries if e["image"])
    print()
    print(f"rows          : {len(entries)}")
    print(f"cards (expanded): {cards}")
    print(f"rows with image : {withimg}")
    print(f"written        : {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
