# Why these hashes changed on 2026-08-16

They are a pin on the SINGLE-CHARACTER prompt: every existing Photo Match run uses it, and a change
there must be deliberate, not a side effect of building something else. Re-blessing them is a
decision, and this file is the record of it.

## What changed, and why

An UNBLURRED source photo now gets one extra sentence:

> The face visible in image N belongs to a DIFFERENT woman. It is the one thing in that photograph
> you must NOT keep — not its shape, not its features, not a softened version of it.

Two things forced it (owner, 2026-08-16, with the screenshot):

1. `sourceFaceBlurred` was read off the page TOGGLE rather than off the photo. The blur detector
   misses turned and partly-hidden faces — the amber "FACE - TAP" badge is exactly that case — so
   the prompt announced "the face is deliberately blurred" about photos with a sharp face still in
   them, and said nothing at all about the real face sitting there.
2. Those are precisely the runs where identity fails, because the model has a complete, well-lit
   face in frame and every reason to keep it.

The blur note itself is unchanged and still fires when the photo really was blurred. A faceless run
gets neither line, because its face is out of shot by construction.

## What did NOT change

Nothing else. The identity list, the locks, NO BLENDING, the camera paragraph and the FINAL lock are
byte-identical; the diff is one added paragraph on the unblurred path.
