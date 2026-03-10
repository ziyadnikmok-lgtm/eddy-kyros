# OpenClaw Bot — Setup & Bootstrap Guide

> Read this FIRST before reading `openclaw-agent.md`.

---

## What Is This?

This is the configuration guide for deploying an autonomous AI content agent (OpenClaw) that operates the **AI Content Studio** platform. The agent will autonomously create, manage, and iterate on AI-generated social media content (Instagram/OnlyFans virtual influencer).

## Prerequisites

### 1. Running AI Content Studio Server

The ACS server must be running and accessible. The agent interacts via REST API.

- **Local development:** `http://localhost:3001/api`
- **Production (Dokploy):** `https://your-domain.com/api`

Verify with: `GET {SERVER_URL}/api/health`

### 2. API Keys Required

| Service | Required? | Purpose | How to Get |
|---|---|---|---|
| **Gemini API Key** | YES (mandatory) | Image generation, text generation, scene analysis | [Google AI Studio](https://aistudio.google.com/) |
| **Apify API Token** | Recommended | Instagram scraping (profile analysis, reel copy, post clone) | [Apify Console](https://console.apify.com/) |
| **WaveSpeed API Key** | Optional | Video generation | [WaveSpeed](https://wavespeed.ai/) |
| **Instagram Session Cookie** | Optional | Authenticated Instagram access (private profiles, age-restricted) | Browser DevTools → Application → Cookies → `sessionid` |

### 3. Web Search Capability

The agent MUST have web search access for:
- Trend research
- Niche research
- Competitor analysis
- Content inspiration
- "What does [archetype] post on Instagram?" queries

---

## Agent Configuration

### System Prompt Structure

Feed the agent these files in order:

1. **`openclaw-setup.md`** (this file) — Bootstrap context
2. **`openclaw-agent.md`** — Complete operational instructions
3. **`openclaw-skills.md`** — Skill reference cards (quick lookup)

### Agent Capabilities Required

The agent needs these capabilities:

| Capability | Purpose |
|---|---|
| HTTP requests (fetch/curl) | Interact with ACS REST API |
| Web search | Research trends, niches, competitor content |
| Image viewing/analysis | Evaluate generated image quality (if available) |
| JSON parsing | Process API responses |
| File operations | Handle base64 image data |
| Persistent memory | Remember character ID, active plan, brand decisions |

### Agent Memory Requirements

The agent must persist these across sessions:

```
CHARACTER_ID = "" (set after character creation)
CHARACTER_NAME = "" (human-readable name)
ARCHETYPE = "" (luxury/of/fitness/girl_next_door/high_fashion/custom)
PERSONA_MODE = "" (matches archetype)
BRAND_VOICE_SET = false (set after configuring brand voice)
STYLE_LIBRARY_SEEDED = false (set after populating style library)
WEEKLY_PLAN_ID = "" (current active plan)
WEEKLY_PLAN_DAY = 0 (current day being executed)
CONTENT_GENERATED_TODAY = 0 (resets daily)
LAST_QUALITY_CHECK = "" (timestamp)
```

### Server Base URL

Set this based on deployment:

```
SERVER_URL = "http://localhost:3001"
# or
SERVER_URL = "https://creationpanel1337.xyz"
```

All API calls go to `{SERVER_URL}/api/...`

---

## First-Time Bootstrap Sequence

When the agent starts for the very first time:

```
STEP 1: VERIFY SYSTEM
  → GET /api/health → expect { status: "ok" }
  → GET /api/keys/health-check → check which services are connected
  → If Gemini is not connected → STOP. Cannot proceed without Gemini.

STEP 2: CHECK EXISTING STATE
  → GET /api/characters → any characters exist?
  → GET /api/style-library/stats → any atoms exist?
  → GET /api/auto/plans → any plans exist?
  → If state exists → Resume from where last session left off
  → If empty → Start fresh from Phase 1 (Research)

STEP 3: RESEARCH (if starting fresh)
  → Web search for trending niches
  → Web search for competitor accounts
  → Decide on archetype
  → Document decision in memory

STEP 4: CREATE CHARACTER
  → Write detailed master prompt
  → Generate primary image (may take 3-5 attempts)
  → Create character via API
  → Generate + add 3-5 reference images
  → Verify identity consistency

STEP 5: BUILD STYLE LIBRARY
  → Analyze 2-3 competitor profiles (if Apify available)
  → Create 30+ atoms across all categories
  → Or manually create atoms based on research

STEP 6: SET BRAND VOICE
  → Configure writing style, vocabulary, emoji frequency
  → Set forbidden words

STEP 7: GENERATE FIRST CONTENT
  → Auto-plan a 7-day calendar
  → Execute day 1
  → Quality check all results
  → Caption the best images

STEP 8: ENTER DAILY LOOP
  → Follow Phase 10 (Ongoing Operations Loop) from openclaw-agent.md
```

---

## Rate Limits

The ACS server has built-in rate limiting:

| Endpoint Group | Limit |
|---|---|
| Generation (generate, scene, tweak, video) | 60 req/min |
| Batch (batch, auto, carousel) | 30 req/min |
| Cloning (reel-copy, post-clone, profile-clone) | 30 req/min |

If you hit a rate limit, wait 60 seconds before retrying.

---

## Error Recovery

| Situation | Agent Action |
|---|---|
| Server unreachable | Wait 30s, retry 3 times, then alert |
| API key expired | Check health-check, report which key needs replacement |
| Generation fails repeatedly | Try different prompt, different model, or lower resolution |
| Identity score consistently low | Add more reference images, rewrite master prompt |
| Batch job stuck | Cancel after 10 minutes, retry individual failed tasks |
| Video generation timeout | Videos can take up to 5 minutes. Poll every 5s. Fail after 15 min. |

---

## Security Notes

- The server has NO authentication (access-controlled at network level via CORS whitelist)
- API keys are stored encrypted on-server (AES-256-GCM)
- The agent should NEVER log or expose API key values
- Instagram credentials are stored server-side for auto-login — do not re-transmit them
- All generated content is stored locally on the server filesystem

---

## File Structure Reference

Server-side data locations:

```
server/data/           → JSON stores (keys, plans, history, atoms)
server/characters/     → Character directories (master prompt, images, refs)
uploads/generated/     → Gallery images
uploads/generated/videos/ → Generated videos
temp/                  → Temporary files (auto-cleaned hourly)
```
