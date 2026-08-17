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

# Why they changed again on 2026-08-16 (second time)

The tattoo rule became ABSOLUTE. It used to read:

> <her> has only the tattoos visible in her reference images.

That is a PERMISSION, not a prohibition. It tells the model tattoos are part of her whenever a
reference happens to show one, and it leaves the door open to inventing a plausible one — the owner
reported exactly that ("it did the tattos we never wanna have tattos").

It now says she has clean unmarked skin, and names all three ways ink arrives: copied from the
source, carried over from her references, or invented. An absolute is also far harder to talk a
model out of than a comparison between two photographs.

Nothing else changed.

# And again on 2026-08-16 (third time) — the skin instruction

The photoreal line was mostly a list of things NOT to do:

> Photorealistic — real pores, hair strands, fabric, slight asymmetry; no plastic or CGI look.

A negative leaves the model to pick what to do instead, and what it picks is the smooth,
evenly-lit, retouched look that reads as AI at a glance. It now names positives — pore texture,
stray hairs, uneven specular (shiny where oily, matte elsewhere), blemishes kept rather than
retouched — and 2K is the default resolution.

Kept under 300 characters on purpose. It is still the FIRST paragraph dropped at the cap, because
it improves a picture that is already of the right woman while the identity lock decides whether
she is. A 640-character first attempt was dropped on every single run, which is worse than useless.

# Why `exact`, `outfit` and `budget` changed on 2026-08-17

Owner: "i selected exact recreate it doesnt do the exact recreate at all."

Diffing the two prompts explained it. The switch changed ONE sentence out of fifteen paragraphs:

    on:  "Reproduce image 5 exactly — same background, pose, props, framing, lighting, outfit"
    off: "A new photo of Grace in image 5's scene, not a retouch of image 5."

and BOTH modes already carried "From image 5: background, pose, hands/props, outfit, expression,
lighting" plus the CAMERA paragraph. So the model read nearly the same instruction either way, with
the one distinguishing sentence sitting fifth from the top, where the weight is lowest.

Worse, two later paragraphs contradicted it outright:

  * `Lighting: Lighting is soft and diffused lighting, glowing naturally on her skin` — the house
    default, added 2026-08-13 for every prompt. Against "same lighting" it cannot be obeyed, it sits
    later, and softening is also the safer default. Now suppressed on an exact recreate only.
  * SCENE AND CAMERA asks for natural depth of field and highlights that roll off — both changes to
    how the source LOOKS. An exact recreate now gets a variant that keeps the source's own optics.

And the switch gained a tail paragraph, the same position that already makes the identity lock and
the bust lock work.

THE THREE THAT MOVED ARE EXACTLY THE THREE WITH exactRecreate ON — `exact`, `outfit` (which sets it)
and `budget`. `plain`, `nude`, `faceless` and `camera` are byte-identical, which is the check that
this was scoped rather than a rewrite of every prompt.

Seedream's cap made this tight: the exact-recreate lock has a short form sized to fit in the gap the
removed lighting line leaves, so the tab gains the lock without the trim loop eating the skin
paragraph. Measured — an ordinary single-character exact run is 2,991 of 3,000 and drops nothing.
