"""Pair each pose with the video prompt that describes the same shot.

The two collections share no images — the pose images were replaced after the video sheet was
made — so they can only be matched on what they DESCRIBE. A pose card says how she is
positioned; a video title says what she does in that position. When both mention kneeling and
feet, they are the same shot.

Scoring is deliberately conservative. A wrong pairing is worse than no pairing: it would send
the wrong motion to a generation that costs money, and it would look like the feature is broken.
Anything below the confidence floor is left unpaired for the user to do by hand.

Output: Downloads/eddy-poses-with-video.json — the user's own poses and images, unchanged, with
videoPrompt filled in only where a confident match was found.
"""
import json
import pathlib
import re
from collections import Counter

POSES = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-posess.json")
VIDEOS = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-video-prompts.json")
OUT = pathlib.Path(r"C:\Users\asusg\Downloads\eddy-poses-with-video.json")

# Words that appear in nearly every entry carry no signal — they would make everything look
# similar to everything. Dropped before scoring.
STOP = {
    "the", "and", "her", "she", "with", "into", "from", "this", "that", "while", "then",
    "both", "very", "look", "looking", "camera", "image", "reference", "exact", "same",
    "main", "girl", "body", "hair", "skin", "tone", "outfit", "proportions", "locked",
    "shot", "video", "seconds", "style", "keep", "keeps", "kept", "front", "back", "side",
    "slightly", "towards", "toward", "over", "under", "down", "back", "position", "pose",
    "characters", "setting", "story", "beats", "duration", "cuts", "movement", "framing",
}

# The words that actually distinguish one shot from another in this collection.
SIGNAL = {
    "kneeling", "kneel", "knees", "reclining", "lying", "laying", "sitting", "sits", "seated",
    "standing", "stands", "straddle", "squat", "squatting", "arched", "arch", "bent", "spread",
    "raised", "legs", "leg", "feet", "foot", "toes", "soles", "thighs", "ass", "butt", "cheek",
    "breasts", "tits", "chest", "cleavage", "mouth", "tongue", "ahegao", "licking", "lick",
    "spitting", "spit", "saliva", "jiggle", "jiggling", "shaking", "bounce", "bouncing",
    "belly", "rolls", "rolling", "cowgirl", "riding", "doggy", "allfours", "shoulder",
    "flexible", "flexibility", "stretch", "split", "splits", "curling", "curled", "pointed",
}


def words(text):
    return [w for w in re.findall(r"[a-z]+", str(text or "").lower()) if len(w) > 2 and w not in STOP]


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


def score(pose_words, vid_words):
    """
    Overlap weighted toward the words that distinguish shots.

    A shared signal word (kneeling, toes, arched) counts triple: two entries both mentioning
    "toes" is real evidence, whereas both mentioning "slowly" is not.
    """
    pset, vset = set(pose_words), set(vid_words)
    if not pset or not vset:
        return 0.0
    shared = pset & vset
    if not shared:
        return 0.0
    weight = sum(3 if w in SIGNAL else 1 for w in shared)
    denom = sum(3 if w in SIGNAL else 1 for w in min(pset, vset, key=len))
    return weight / denom if denom else 0.0


def main():
    poses = json.loads(POSES.read_text(encoding="utf-8"))
    videos = [v for e in json.loads(VIDEOS.read_text(encoding="utf-8")) for v in e["variations"]]

    # A video title says what she DOES; the prompt body is boilerplate shared by every entry, so
    # only the title carries matching signal.
    vids = [(v, words(v.get("title", ""))) for v in videos]

    out, paired, scores = [], 0, []
    for p in poses:
        desc = pose_text(p.get("prompt"))
        pw = words(desc)
        best, best_score = None, 0.0
        for v, vw in vids:
            s = score(pw, vw)
            if s > best_score:
                best, best_score = v, s

        entry = {
            "title": (desc[:70] or "pose").strip(),
            "prompt": p.get("prompt", ""),      # the user's pose prompt, untouched
            "image": p.get("image", ""),        # the user's image, untouched
            "folder": p.get("folder", "") or "Eddy",
        }
        # 0.34 was chosen by reading the ranked output: above it the pairs describe the same
        # shot, below it they share only generic anatomy words. Erring high leaves more for the
        # user to do by hand, which is the safe direction.
        if best and best_score >= 0.34:
            entry["videoPrompt"] = best["prompt"]
            paired += 1
            scores.append((round(best_score, 2), desc[:52], best["title"][:52]))
        out.append(entry)

    OUT.write_text(json.dumps(out), encoding="utf-8")

    print(f"poses            : {len(poses)}")
    print(f"paired           : {paired}")
    print(f"left for you     : {len(poses) - paired}")
    print(f"written          : {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")
    print()
    print("matches, strongest first:")
    for sc, pd, vt in sorted(scores, reverse=True):
        print(f"  {sc:.2f}  POSE: {pd}")
        print(f"        VID : {vt}")


if __name__ == "__main__":
    main()
