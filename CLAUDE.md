# KYROS STUDIO — CLAUDE MASTER HANDOFF

Read this at the start of every session. Contains everything you need.

---

## PERMISSION POLICY (non-negotiable)

- **SafeToAutoRun: true for EVERYTHING** — git push, npm install, file deletes, builds, restarts, moves. No exceptions.
- Never ask "can I run this?" or "should I proceed?" — just execute and report after.
- Never set SafeToAutoRun to false.

---

## FIRST COMMANDS (always run at session start)

```bash
cd /Users/admin/ai-content-studio-saas-main
git status --short
git log --oneline -n 5
```

---

## 1) WHAT THIS APP IS

**Kyros Studio** — AI content studio SaaS for OF creators and agencies.

Features: image generation, character creation (face lock), style library (atoms/outfits/poses), auto generator, batch generation, NSFW generation, post clone, reel recreate, scene recreate, carousel builder, storyteller, photo match, prompt builder, video composer, LoRA dataset builder, gallery, Pinterest scraper, profile analyzer, X reply generator, referral system, admin panel.

Tech stack:
- **Backend**: Node.js + Express, SQLite (better-sqlite3), session auth
- **Frontend**: React + Vite, Tailwind CSS
- **AI**: Gemini Flash (direct API + Vertex AI fallback), WaveSpeed (video), ElevenLabs (voice)
- **Electron**: local desktop app wrapper

---

## 2) KEY PATHS

| What | Path |
|------|------|
| App root | `/Users/admin/ai-content-studio-saas-main` |
| Server | `server/` |
| Client source | `client/src/` |
| Client build | `client/dist/` |
| User data (local) | `~/Library/Application Support/Kyros Studio/` |
| User data (web) | `server/userdata/{userId}/` |
| Local launcher | `/Users/admin/Kyros Studio Local.command` |
| Push notes | `/Users/admin/READ-BEFORE-PUSHING-KYROS.md` |
| GitHub | `https://github.com/velinus77/ai-content-studio-saas` (branch: `main`) |
| Live site | `https://kyros-studio.xyz` |
| App port | `3001` |

---

## 3) FOLDER STRUCTURE

```
server/
├── index.js              # Express app entry, mounts all routes
├── db.js                 # SQLite setup, migrations, SEED_ADMIN_EMAIL auto-promote
├── config.js             # App config (env vars, limits)
├── paths.js              # Per-user file path resolution (getCharactersDir, getDataDir etc.)
├── userContext.js        # AsyncLocalStorage — getUserId() / runWithUser()
├── routes/
│   ├── admin.js          # Admin panel routes (requireAdmin/requireOwner)
│   ├── authRoutes.js     # Login, register, /me, sessions
│   ├── characters.js     # Character CRUD + image upload
│   ├── generate.js       # Main image generation
│   ├── nsfwGenerate.js   # NSFW generation
│   ├── batch.js          # Batch generation
│   ├── auto.js           # Auto generator (plans + execute)
│   ├── gallery.js        # Gallery management
│   ├── styleLibrary.js   # Style atoms (outfits, poses, expressions, scenes)
│   ├── keys.js           # API key management (Gemini, Vertex, WaveSpeed, Apify)
│   ├── billing.js        # Stripe billing + subscriptions
│   ├── referral.js       # Referral system + commissions
│   ├── postClone.js      # Post clone feature
│   ├── reelCopy.js       # Reel recreate
│   ├── carousel.js       # Carousel builder
│   ├── scene.js          # Scene recreate
│   ├── story.js          # Storyteller
│   ├── photoMatch.js     # Photo match
│   ├── videoCompose.js   # Video composer
│   ├── video.js          # Video generation (WaveSpeed)
│   ├── pinterest.js      # Pinterest scraper
│   ├── profileAnalyzer.js# Profile analyzer
│   ├── xReply.js         # X/Twitter reply generator
│   ├── reformat.js       # Caption reformat
│   ├── tweak.js          # Image tweak
│   ├── loraDatasets.js   # LoRA dataset builder
│   ├── outfits.js        # Outfit memory
│   ├── sceneMemory.js    # Scene memory
│   └── ... (many more)
├── services/
│   ├── geminiBackend.js  # Routes to geminiService OR geminiVertexService
│   ├── geminiService.js  # Direct Gemini API calls
│   ├── geminiVertexService.js # Vertex AI Gemini calls
│   ├── apiKeyManager.js  # Per-user API key storage + active key selection
│   ├── referenceManager.js   # Character file storage (per-user path)
│   ├── referralService.js    # Referral tracking + commissions
│   ├── galleryManager.js     # Gallery file management
│   ├── styleLibrary.js       # Style atom storage
│   ├── wavespeedService.js   # WaveSpeed video generation
│   └── ... (many more)
└── middleware/
    ├── requireAuth.js    # Session auth + requireOwner + requireAdmin
    ├── multipartParser.js# Custom multipart parser (AsyncResource context fix)
    ├── upload.js         # Image upload validation
    ├── planLimits.js     # Trial/free plan enforcement
    ├── rateLimiter.js    # Per-user rate limiting
    └── errorHandler.js   # Global error handler

client/src/
├── App.jsx               # Routes, sidebar, StatusDot, plan badge
├── context/AppContext.jsx# Global state: user, keys, characters, vertexActive
├── pages/
│   ├── AdminPage.jsx     # Admin panel (users, promote, owner toggle)
│   ├── ApiKeysPage.jsx   # API key management + Vertex setup
│   ├── CharactersPage.jsx# Character management
│   ├── GeneratePage.jsx  # Main image gen
│   ├── LandingPage.jsx   # Public landing page (noir + coral design)
│   └── ... (30+ pages)
├── components/           # Shared UI components (UI.jsx, ImageEditor, etc.)
├── services/api.js       # All API calls — single request() function
└── hooks/                # useAsync, useDebounce, etc.
```

---

## 4) STANDARD WORK LOOP

```bash
# 1. Make changes in source files
# 2. If client changed — build
pnpm --dir client run build

# 3. Restart local app (ALWAYS use this — it always works)
pkill -f "Kyros Studio" 2>/dev/null; pkill -f "electron" 2>/dev/null; sleep 1; open /Applications/kyros.command

# 4. Test locally
# 5. Push only when user asks
```

---

## 5) SAFE PUSH

```bash
cd /Users/admin/ai-content-studio-saas-main
git pull --rebase origin main
pnpm --dir client run build

git add client/src client/public client/dist server package.json CLAUDE.md DEPLOY_NOTES.md
git commit -m "describe change"
git push origin main

# Verify
git rev-parse HEAD && git ls-remote origin refs/heads/main
# Both hashes must match
```

**Never** use `git add .` — downloads folder has thousands of random files.

---

## 6) FORCE DEPLOY TO PRODUCTION

Trigger Dokploy rebuild via webhook:

```bash
curl -s -X POST "http://62.238.10.47:3000/api/deploy/jR1rXQU8zTs3enub8R6x5" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"ref":"refs/heads/main","repository":{"clone_url":"https://github.com/velinus77/ai-content-studio-saas"}}'
```

Check site after ~2 min:
```bash
curl -s https://kyros-studio.xyz/api/health
```

Dokploy server: `62.238.10.47` | App id: `kyros-studio-zeodkp`

---

## 7) SKILLS AVAILABLE (invoke with Skill tool)

### Always check before doing anything
- `/browse` — ALL web browsing, Dokploy UI, QA testing. Never use mcp chrome tools.
- `superpowers:brainstorming` — before any new feature or creative work
- `superpowers:systematic-debugging` — for any bug
- `superpowers:verification-before-completion` — before claiming work is done

### Development
- `ship` — full deploy workflow
- `review` — code review before landing
- `qa` — systematic QA of the web app
- `investigate` — root cause debugging
- `health` — code quality dashboard
- `security-review` — security audit

### Design
- `frontend-design:frontend-design` — create production-grade UI
- `design-review` — visual QA pass
- `design-consultation` — full design consultation

### Content / Video
- `smart-video-producer` — full video from transcript
- `video-caption` — add text + audio to video
- `ai-image-generation` — generate AI images
- `ai-voice-cloning` — TTS / voice generation
- `claude-video-vision:watch-video` — analyze any video file

### Research / Intel
- `research` — deep Gemini research
- `tiktok-intel` — TikTok profile scrape + analysis
- `crawl` — crawl any website

### Planning
- `superpowers:writing-plans` — write implementation plan from spec
- `superpowers:executing-plans` — execute a written plan
- `plan-eng-review` — engineering plan review
- `office-hours` — product strategy / YC-style

---

## 8) GSTACK BROWSER (use for all web browsing)

```bash
B=~/.claude/skills/gstack/browse/dist/browse
$B goto https://url
$B screenshot /tmp/screen.png
$B snapshot -i        # interactive elements
$B click @e3
$B fill @e2 "value"
```

---

## 9) KEY TECHNICAL PATTERNS

### AsyncLocalStorage (CRITICAL)
Every request runs `runWithUser(userId, fn)` in `requireAuth`. This sets the user context for `getUserId()` which determines file paths for characters, gallery, etc.

**Problem**: `req.on('data')` / `req.on('end')` stream callbacks lose this context.
**Fix**: `multipartParser.js` uses `AsyncResource.runInAsyncScope(next)` to preserve context.
**Never remove this** or characters/atoms will save to wrong folder (`server/characters/` fallback).

### API Key routing
- `apiKeyManager.getActiveKey()` — returns user's Gemini key or null if Vertex
- `geminiBackend.js` — routes to `geminiService` or `geminiVertexService` based on `shouldUseVertexBackend()`
- Vertex users: no Gemini key needed — auth via GCP service account JSON
- Client: `vertexActive` global state in AppContext shows Vertex status

### User roles
- `is_admin` — admin panel access
- `is_owner` — SEED_ADMIN_EMAIL auto-promoted on startup, can grant owner to others
- `requireOwner` in `requireAuth.js` — DB-backed check

### Plan limits
- `planLimits.js` middleware — enforces trial/free limits
- Trial = 10 free generations
- Pro = subscribed via Stripe

---

## 10) ENVIRONMENT VARIABLES (production Dokploy)

```
ENCRYPTION_SECRET=<64-char hex — generated per install, never commit>
SESSION_SECRET=<64-char hex — generated per install, never commit>
SEED_ADMIN_EMAIL=<your admin email>
SEED_ADMIN_PASSWORD=<your admin password — never commit>
APP_URL=<https://yourdomain>
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
RESEND_API_KEY=<re_... from resend.com — never commit>
```

> These are examples. Real values live only in the local `.env`, which is not
> tracked — the desktop app generates its own on first launch. Never paste real
> secrets into documentation: docs get committed and shared.

---

## 11) KNOWN ISSUES + FIXES

| Issue | Fix |
|-------|-----|
| Characters disappear on refresh | `multipartParser.js` AsyncResource fix — preserves userId context through stream callbacks |
| Vertex users get "No active API key" | `getActiveKey()` returns null for Vertex; removed bad `if (!apiKey)` guards from 4 routes |
| Pro users still rate limited | Auth route checks `sub.status === 'active'` before returning plan |
| logAdminAction field name | Must use `actionType` not `action` |
| GCP credentials error | User needs correct GCP project — check they're using `kyros-studio-new` not old project |

---

## 12) DO NOT DO

- Do not use `git add .`
- Do not commit: credentials, local DB, session dumps, media archives, `userdata/`, `.env`
- Do not change production env vars unless explicitly asked
- Do not ask "can I run this?" — just run it
- Do not claim "pushed" without hash verification
- Do not use `mcp__claude-in-chrome__*` tools — use `/browse` skill instead

---

# BUG-EARNED RULES (added 2026-08-09)

Everything below was written after a day of Library-filing bugs. Each rule exists because the thing
it describes actually broke, on the date given. It sits alongside the handoff above, not instead of
it — the handoff covers permissions, paths, deploy and skills; this covers what silently breaks.

Rules for anyone (human or AI) changing this repo. Every one of them exists because the thing it
describes actually broke, on the date given. They are not style preferences.

## The shape of this app

Electron + React client (`client/`), Express server (`server/`). One codebase, three **workspaces**
(Eddy / Ziyad / Max) that differ ONLY in which nav sections they show — `client/src/lib/workspace.js`.
A change lands in all three at once; there is no per-workspace build.

The owner uses **Eddy** and **Photo Match**. Everything else is secondary.

---

## 1. A new page must be registered in FOUR places, or it silently does nothing

Adding a page to the sidebar is not enough. `AppContext.pageFromPathname` falls back to `'eddy'` for
any id it does not recognise, so an unregistered page **renders a different page with no error**.

Shipped broken this way: **Max Outfit, 2026-08-09** — in the sidebar, in the page map, invisible.

| where | what |
|---|---|
| `client/src/App.jsx` | the lazy import + the `PAGES` map entry |
| `client/src/App.jsx` | the sidebar `{ id, label }`, plus its icon and colour |
| `client/src/context/AppContext.jsx` | **`VALID_PAGE_IDS`** — the one that is always forgotten |
| `client/src/App.jsx` | the hidden-feed lists, if the page has its own results column |

`check_maxoutfit.js` walks every sidebar id and fails if any is missing from `VALID_PAGE_IDS`. Keep
that check alive.

## 2. Lint runs. Do not ship past it

`client/eslint.config.js` — `npm run lint`. Deliberately narrow: **`no-undef` is an error**,
hygiene rules only warn (102 pre-existing warnings; a config that fails on day one gets deleted).

There was no lint config until 2026-08-09, and Vite does not care about an undefined identifier — it
only transpiles. Two live bugs were sitting in the tree because of it:

- **`poseView`** used ~300 lines outside the block that declared it. Every generation threw
  ReferenceError at the Library write, was caught, and surfaced as a toast nobody read. The image
  rendered and never reached the Library. **This was the "it doesn't send to Library" bug.**
- **`load()`** called where the function is `refresh()` — the star sweep threw at the end and the
  grid never re-read.

It caught a third within the hour: a cleanup that deleted `eddyTags` along with its neighbour.

## 3. Never swallow a failure that decides where a paid image goes

The Library write sat inside its own `catch {}` with the note *"the picture is safe in the main
gallery either way"*. True, and exactly why it was wrong: the swallow meant the outer handler's
`"Saved to the gallery but not to Eddy"` toast — written for that failure — **could never fire**.

Related, and worse: **`addItems` does not throw on a storage failure.** It skips the row and returns
normally, with the count on `added.failed`. A skipped row is indistinguishable from a success unless
the caller checks the returned array. Check it.

## 4. `folderId: null` is not "unsorted", it is INVISIBLE

The Library lists items by folder. A row with no folder appears under "All" and in **no folder at
all**. 89 pictures reached that state on 2026-08-09 and read as never having arrived — they were
safe the whole time, just unreachable.

`resolveLibraryFolder` ends every branch in a `generic()` floor for this reason. Worst case must be
"in the wrong folder" (recoverable by dragging), never "nowhere".

## 5. The folder rule: ONE FOLDER PER CHARACTER

`Grace`. Nothing above it, nothing below it, on **every** tab — Eddy, Max Nano, Max Outfit,
Photo Match. Settled 2026-08-09 after two failed attempts:

- `Grace Seedream` / `Grace Nano` as flat siblings — sorted away from her own folder, so opening
  Grace showed none of it.
- `Grace > Seedream` and `Max Nano > Grace` as subfolders — splits her work by a distinction that
  matters only while comparing engines, and gets in the way every other day.

Tab folders (`Max Nano`, `Eddy`, `Eddy NSFW`) survive for runs with **no character picked** only.

**Changing this scheme strands every image already filed.** If it changes again, say so out loud and
do not bulk-move the owner's existing images silently.

## 6. `_addItems` has an ALLOWLIST. A new field is dropped without a word

`client/src/lib/eddyCollectionStore.js` — any field not named there vanishes. `videoPrompt` was lost
this way once, `poseView` nearly was. Add the field to the allowlist in the same commit that starts
sending it.

## 7. Persisted state: a field in the snapshot must be in the effect's deps

`EddyGeneratePage`'s snapshot effect is the **only** thing that writes it. A field in `snap` but not
in the deps array never gets saved — the effect does not re-run, and the value is gone next launch.
`pickedBases` / `outfitRotation` / `smartMatch` all shipped this way.

`check_charfolder.js` parses both as lists and fails on any mismatch.

## 8. Filing happens in the BROWSER. The server bills either way

A generation is saved and charged whether or not the tab survives. Reload, crash or close mid-batch
and the picture is safe on disk and missing from the Library. `RecoverFromGallery` now sweeps
automatically on every Library open — quiet when there is nothing to do, deduped on gallery id so it
can never double-file.

Recovery must file **exactly the way a live run files**, or it just moves the problem. It also reads
the character back off the generation's tags, which is why `eddyTags()` sends her name.

## 9. Do NOT delete the gallery

Measured 2026-08-09: **9.6 GB, 4,002 files**. A Library row stores a **URL into the gallery, not
bytes** — deliberately, so a 25-image batch does not pour tens of megabytes into IndexedDB.

Delete `/api/gallery` and every Library row goes black. Holding bytes instead is ~1.7 GB on day one
and ~1.6 GB per 500-image batch, in a store whose quota failure *silently skips rows*.

The browsing **pages** were the problem and both are gone (`GalleryPage` deleted; the `library` row
off the sidebar). `LibraryPage` stays reachable by URL — it is still the only surface listing Batch
and Carousel output.

## 10. Concurrency is bounded by the server's rate limiter, not by taste

`generateLimiter`: **60 requests / 60 s** on `/api/seedream`, shared by every page. A lane issues one
request and waits out the whole generation, so the rate is `lanes / duration`, not `lanes`.

Current: Eddy 12 (Seedream) / 6 (nano2), Photo Match 4 → about 21 of 60 when both run. The friend's
pipeline reports 429s at 30 concurrent workers. Raising these means redoing that arithmetic, and
anything raised needs a 429 retry on that path first — Photo Match had none when it went to 4.

---

## Working with Eddy (the collaborator)

Remote `friend` → `share-clean`. **Push with `python tools/share-push.py <files> -m "..."`.**

That script exists because fetching first is not enough — I fetched, then overwrote anyway, four
times on 2026-08-09: an `eddy.css` rule, `CLAUDE.md`, a stale-comment cleanup, and his entire
"unfinished run survives a restart" feature. Every one was caught by reading the diff afterwards,
and noticing afterwards is not a process.

The two histories are unrelated (742 local commits share no base with his branch), so a real merge
is unavailable and every push is a whole-file copy — a silent overwrite by construction. The script
compares his version to mine per file and REFUSES when any line exists on his side and not on mine.

**When it refuses, do not reach for `--force`.** Copy his version down, re-apply your change on top,
run it again:

```bash
git show friend/share-clean:<file> > <file>   # his version becomes the base
# re-apply your change with anchors that FAIL LOUDLY if they are missing
python tools/share-push.py <file> -m "..."
```

`--force` is for when the owner has read the report and decided his version should go.

When his change and a requested change conflict, **merge, do not pick a side**, and say which parts
came from where.

## Verification

`npm run lint` and a clean `vite build` are the floor, not the ceiling.

The checks live in the session scratchpad (43 suites). The ones that matter **execute** code rather
than pattern-matching it — pattern checks passed while three real bugs shipped today:

- `check_filing_e2e.js` — loads the **real** `eddyCollectionStore` on a fake IndexedDB and files
  images the way `generateCombo` does. Catches folder-scheme regressions and concurrent-batch races.
- `check_charfolder.js` — drives `resolveLibraryFolder` against a recording fake store.
- `check_smart.js`, `check_maxoutfit.js` — replay the combo builders.

**Nothing here has been verified by generating a real image.** Every claim in this file is about code
behaviour. The app is Electron + browser IndexedDB; a generation triggered outside it does not touch
the Library. On-screen verification is the owner's, and it has caught what the checks did not.
