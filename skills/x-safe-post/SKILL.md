---
name: x-safe-post
description: Safely create X (Twitter) posts via desktop automation with explicit preflight checks and optional final confirmation. Use when posting media/captions from local files on macOS and you need reliability over speed.
---

# X Safe Post

Use this skill to post to X with guardrails.

## Requirements

- macOS with Google Chrome installed
- Privacy permissions granted for automation
- In Chrome: **View → Developer → Allow JavaScript from Apple Events** enabled

## Script

Run:

```bash
node /Users/admin/.openclaw/workspace/skills/x-safe-post/scripts/post.js \
  --image "/absolute/path/to/image.jpg" \
  --caption "your caption" \
  --confirm
```

### Modes

- `--confirm`: stops before final click and prints `READY_TO_POST`
- `--post-now`: clicks Post automatically after checks

## Safety checks performed

1. Opens `https://x.com/compose/post`
2. Fills caption
3. Opens file dialog and selects image path
4. Verifies media preview exists
5. Verifies Post button is enabled
6. Posts only if `--post-now` is provided
