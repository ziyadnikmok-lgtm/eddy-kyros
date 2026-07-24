# Kyros Assistant (chatbot) — design spec

**Date:** 2026-07-18
**Status:** approved, ready for implementation planning

## Goal

An in-app chat assistant that drives Kyros's existing tools from plain-language
requests. First target, in the user's words: *"give it a link and tell it take the frame
and recreate with Grace in Photo Match, and it does it."* Long-term: drive every tool by
chat. Built in stages — Phase 1 lights up the link → frame → Photo Match · Seedream
pipeline end to end; later phases register more tools.

## Decisions (locked)

- **Scope:** full assistant architecture, tools lit up in stages. Adding a tool is one
  registry entry, so the number of tools is not an architectural cost.
- **Control:** **plan → confirm → run.** Nothing spends money without an explicit "Go"
  tap. The planner only PLANS; it cannot execute. A misread request can never burn
  credits — the user simply doesn't tap Go.
- **Frame picking:** **show-and-tap.** When a request needs a frame from a grabbed reel,
  the executor shows the grabbed frames in the chat and waits for the user to tap which
  one. A reel has ~10 frames and only the user knows the pose they want; auto-pick would
  risk generating from the wrong frame.
- **LLM:** the user's existing Gemini (or Vertex) key — the same key already used across
  the app. No new provider.

## Architecture

Four components, each with one job:

### 1. Assistant page — `client/src/pages/AssistantPage.jsx`
A new sidebar tab (nav id `assistant`, in a suitable section). A standard chat:
- message list (user + assistant turns),
- an input box,
- **plan cards** rendered inline (ordered steps + per-step cost + total + a **Go** button),
- **frame-pick cards** (a grid of grabbed frames; tapping one resumes the run),
- result images rendered inline; results also land in Library/feed like any generation.

Conversation state is kept per-session (the running plan, the pending frame-pick). No new
persistence store is required for Phase 1; chat history may be ephemeral (in-memory /
sessionStorage) to start.

### 2. Planner — `POST /api/assistant/plan`
Input: the conversation (messages) + the tool catalog (names, descriptions, arg schemas,
cost notes). Calls Gemini/Vertex with a system prompt instructing it to return a
**structured plan** OR a plain reply (if the request is conversational / needs
clarification). Output shape:

```json
{
  "reply": "optional assistant text",
  "plan": {
    "title": "Recreate this reel frame as Grace",
    "steps": [
      { "tool": "grabFrames", "args": { "link": "..." }, "costUsd": 0, "label": "Grab frames from the reel" },
      { "tool": "photoMatchSeedream", "args": { "characterId": "grace", "frame": "PICK" }, "costUsd": 0.048, "label": "Recreate with Grace (Photo Match · Seedream)" }
    ],
    "totalUsd": 0.048
  }
}
```

The planner NEVER calls a tool. It only produces the plan. A step arg value of `"PICK"`
marks a value the user supplies interactively at run time (e.g. which frame).

### 3. Tool registry — `server/services/assistant/tools.js`
A map of tool id → `{ description, argsSchema, estimateCost(args), run(args, ctx) }`.
Each `run` wraps an EXISTING service — no new generation logic. Phase 1 tools:
- `grabFrames({ link })` → Frame Grabber's extractor. Free. Returns frames (id + preview).
- `listCharacters()` / `resolveCharacter(name)` → map "Grace" → character id.
- `photoMatchSeedream({ characterId, frame, options })` → the Photo Match · Seedream route.
- `sceneRecreateSeedream(...)`, `outfitSwapSeedream(...)`, `seedreamEdit(...)`.

The registry is the single source of truth the planner is told about. **Adding a tool =
adding one entry here + describing it to the planner.**

### 4. Executor — `POST /api/assistant/run`
Input: a CONFIRMED plan (post-Go). Runs steps in order, calling `registry[tool].run`.
Streams progress back to the chat (SSE or chunked). When a step arg is `"PICK"`, the
executor pauses and returns the choices (e.g. grabbed frames) to the UI; the UI shows the
frame-pick card, the user taps, and a follow-up call resumes the run with the chosen
value. Spend is tracked exactly as the underlying routes already do (nothing new billed).

## Data flow (the user's example)

1. User: *"grab a frame from instagram.com/… and recreate with Grace."*
2. `POST /plan` → Gemini → plan: [grabFrames (free), photoMatchSeedream (frame=PICK, $0.048)].
3. Chat shows plan card + **Go** ($0.048).
4. User taps Go → `POST /run` → step 1 grabs frames (free) → returns them as a frame-pick.
5. Chat shows the frames → user taps one → resume `POST /run` → step 2 generates.
6. Result image appears in chat + Library.

## Error handling

- Planner returns malformed JSON → surface a plain "I couldn't plan that, can you rephrase?"
  reply; never fabricate a plan.
- A tool `run` throws → stop the run, show the real error in the chat (like `failPending`
  does for the feed), keep already-completed steps' results.
- No character match for a named character → the plan step fails loudly with "I don't have
  a character called X — pick one" rather than guessing.
- Missing/blocked LLM key → clear "Add a Gemini or Vertex key to use the assistant."

## Testing

- Unit: registry `estimateCost` for each tool; `resolveCharacter` name→id; planner
  response parsing (valid plan, plan+reply, reply-only, malformed).
- Integration (mocked LLM + mocked services): plan → confirm → run happy path for the
  Photo Match pipeline, including the frame-pick pause/resume.
- Manual on-device: the real link→frame→Grace flow end to end.

## Out of scope (Phase 1)

- Persistent chat history across app restarts.
- Multi-turn autonomous chaining beyond a single confirmed plan.
- Non-image tools (Seedance video, character training) — registered in a later phase.
- Voice / image upload into the chat (text + link first).

## Staging

- **Phase 1:** Assistant page + planner + executor + registry with the Seedream image
  tools; the link→frame→Photo Match · Seedream pipeline working end to end with plan,
  confirm, frame-pick, run.
- **Phase 2+:** register remaining tools (Outfit Swap, Scene Recreate variants already in;
  then Seedance video, training, presets), add persistent history if wanted.
