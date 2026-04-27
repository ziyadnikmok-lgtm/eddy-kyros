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
ENCRYPTION_SECRET=b42c2e9e86e9507c43aff70c318f5a5568a21b5f3b995ccf09a1be4852392d10
SESSION_SECRET=f5a6d1f1465a76865751221ecc545c27aa505e9c632bac7ddfbecd90ab0b586c
SEED_ADMIN_EMAIL=rekyx2@gmail.com
SEED_ADMIN_PASSWORD=Orly123$
APP_URL=http://62.238.10.47:3001
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
RESEND_API_KEY=re_HZmSNmoa_13VM1CyDATuFGtW3qEWu8ugt
```

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
