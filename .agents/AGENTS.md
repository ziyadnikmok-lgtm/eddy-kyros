# Kyros Studio — Agent Rules & Project Memory

## Owner
- User: cook45 / clack
- Project: AI Content Studio SaaS (Kyros Studio)
- Local path: `C:\Users\asusg\Desktop\ai-content-studio-saas`
- GitHub: `https://github.com/velinus77/ai-content-studio-saas` (private)

## Hard Rules
- NEVER push .env, API keys, userdata/, user images to GitHub
- Friend (eddycasarin55@gmail.com) sets up his OWN API keys — repo is clean code only
- Always `npm run build` in `client/` before committing dist changes
- Server is Express (server/) + Electron shell (electron/main.js) + React client (client/)

## Architecture
- AI backend: Vertex AI (server/services/geminiVertexService.js) + AI Studio (server/services/geminiService.js)
- Frame extraction: server/routes/instagramFrames.js — yt-dlp -> ffmpeg -> Gemini vision
- Client frame logic: client/src/lib/frameExtract.js
- Frame Library UI: client/src/pages/FrameLibraryPage.jsx

## Frame Library Smart Picker v3 (built July 6 2026)
- 2-stage: ffmpeg 120 frames @4fps -> pre-filter black (<8KB) -> 20 candidates -> Gemini ranks top 3
- 3 modes: Brain (AI, default) / Quick (2nd frame @200ms) / Thumbnail (ffmpeg)
- Mode stored in localStorage kyros.frameLibrary.frameMode
- Returns: best, pick2, pick3, faceFrame, outfitFrames
- Disqualification: eyes closed, face away/covered, blurry, back-of-head, black frame, silhouette

## UX Features (built July 6 2026)
- Link history: localStorage kyros.frameLibrary.linkHistory, max 500
- Links stay in textarea after import (not cleared)
- Last 5 min select button — selects frames from last 5 minutes for quick cleanup

## User Preferences
- Frames must show: face visible + eyes OPEN + front-facing + full body
- Wants top 3 options per reel not just 1 guess
- Last 5 min -> delete bad picks -> keep 1 good one
