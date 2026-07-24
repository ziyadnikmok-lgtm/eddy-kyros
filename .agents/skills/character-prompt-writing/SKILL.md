---
name: character-prompt-writing
description: How to write detailed character masterPrompts for Photo Match identity preservation in Kyros Studio. Use when creating or updating character identity descriptions.
---

# Character MasterPrompt Writing Guide

## Purpose
When a character's `masterPrompt` is generic (e.g. "matching from reference photos"), Photo Match fails to preserve identity because Gemini only sees reference images as "Image 1, 2, 3" — it needs a TEXT description of WHO the character IS to anchor identity.

## Workflow
1. **View the character's primary reference images** at `%APPDATA%/ai-content-studio/characters/<name>/primary_*.jpg`
2. **Analyze the person** in the photos — face shape, ethnicity, specific features, hair, body type, makeup
3. **Write a structured masterPrompt** using the template below
4. **Edit the character.json** at `%APPDATA%/ai-content-studio/characters/<name>/character.json`
5. The `referenceManager` cache checks file mtime, so changes take effect on next API call

## MasterPrompt Template

```
<Name> is a young <ethnicity> woman in her <age range> with a distinctive, recognizable face.
FACE: <face shape> face, <jawline>, <cheekbones>, <nose description>, <lip description>, <eye color and shape>, <eyebrow description>.
SKIN: <skin tone and texture>, <any marks like freckles>.
HAIR: <length>, <color with specifics>, <texture/style>, <how usually worn>.
BODY: <body type with specific proportions>.
NAILS: <nail style>.
<Name> has NO tattoos, NO body ink of any kind.
```

### For GOTH variants, add:
```
MAKEUP: heavy goth makeup — BLACK lipstick (matte, very dark), dramatic dark smoky eyeshadow, thick black eyeliner with winged tips, long false lashes. The black lipstick is a CORE part of her identity and must NEVER be changed or lightened.
NAILS: long black or dark-colored nails.
```

## Key Rules
- NEVER use circular references like "matching from reference photos" — the AI needs TEXT, not "look at the images"
- Be SPECIFIC about ethnicity, face shape, eye shape, nose shape, lip fullness
- Include body proportions explicitly (the AI tends to normalize body shape without explicit instructions)
- Always end with "NO tattoos, NO body ink" to prevent tattoo transfer from source images
- For goth variants, the BLACK LIPSTICK rule is critical — Gemini loves to "naturalize" dark makeup

## Character Data Location
- Electron: `%APPDATA%/ai-content-studio/characters/<name>/character.json`
- Web: `userdata/<userId>/characters/<name>/character.json`
- Fallback: `server/characters/<name>/character.json`

## Cache Behavior
The `referenceManager._findCharacterById()` uses `_characterCache` (Map) with mtime validation.
File changes on disk are detected automatically via `statSync().mtimeMs` comparison.
No restart needed after editing character.json.

## Examples

### Grace (East Asian)
```
Grace is a young East Asian woman in her early 20s with a distinctive, recognizable face. FACE: soft oval face shape, rounded jawline tapering to a small chin, high cheekbones with natural fullness in the cheeks, small nose with a subtle rounded tip, full plump lips (upper and lower), dark brown almond-shaped eyes with a slight monolid, naturally arched eyebrows that are thin and well-groomed. SKIN: smooth warm-toned light-tan complexion, even skin tone without freckles. HAIR: very long straight jet-black hair reaching past the waist, naturally thick and silky with a center or slight side part. BODY: very curvy hourglass figure with very large volume curves, slim defined waist, wide hips, thick thighs. NAILS: long manicured nails. Grace has NO tattoos, NO piercings other than ears, and NO body ink of any kind.
```

### Sofia (Latina/European)
```
Sofia is a young mixed-ethnicity woman (Latina/European) in her early 20s with a strikingly beautiful, distinctive face. FACE: heart-shaped face with a defined jawline, high prominent cheekbones, small straight nose with a refined tip, full pouty lips (naturally plump upper and lower), large round hazel-green eyes with long natural lashes, naturally thick well-shaped eyebrows with a soft arch. SKIN: light olive-toned complexion with a warm golden undertone, smooth even skin with a subtle natural glow, light freckling on the chest and shoulders. HAIR: very long flowing brunette hair (medium-dark brown with subtle warm caramel highlights), thick and voluminous with a natural soft wave, usually worn loose and swept to one side. BODY: very curvy hourglass figure with very large volume curves, slim toned waist with visible definition, wide hips, thick thighs. NAILS: long manicured nails. Sofia has NO tattoos, NO piercings other than ears, and NO body ink of any kind.
```
