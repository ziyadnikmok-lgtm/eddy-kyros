# Onboarding prompt — new developer on Eddy's Kyros

Paste everything below the line to the new dev (or into their AI assistant).

---

You are helping me set up and work on **Kyros Studio** — a local AI content studio
(Express backend + React/Vite frontend + Electron desktop shell). It generates images
and videos for social content, manages a local gallery, and stores API keys encrypted
on the machine it runs on. Everything runs locally; there is no shared server.

## Get the code

```bash
git clone -b share-clean https://github.com/ziyadnikmok-lgtm/eddy-kyros.git kyros
cd kyros
```

Use the `share-clean` branch. It is a snapshot with no git history — that is
deliberate, so do not try to `git log` your way to context, there is nothing there.

## Install (macOS, Node 18+ required)

```bash
xcode-select --install     # if you have never built a native module on this Mac
brew install node          # or install Node 18+ from nodejs.org
npm install
cd client && npm install && cd ..
```

**Install fresh on the Mac. Never copy a `node_modules` folder from a Windows
machine.** Three dependencies ship platform-specific compiled binaries —
`ffmpeg-static` (video remuxing), `sharp` (image processing) and `better-sqlite3`
(the local database). A Windows `node_modules` contains Windows binaries and the
app will fail at runtime in confusing ways.

## Configure

The README tells you to copy `.env.example` — **that file does not exist**. Create
`.env` in the repo root yourself:

```
ENCRYPTION_SECRET=<64 hex chars, generate below>
SESSION_SECRET=<64 hex chars, generate below>
APP_URL=http://localhost:3001
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Two things that matter:

- **Never commit `.env`.** It is gitignored. Keep it that way.
- **Never change `ENCRYPTION_SECRET` after first run.** API keys are encrypted with
  it; changing it makes every stored key undecryptable and you have to re-enter them.

## Run

```bash
npm run build:client
npm start
```

Then open <http://localhost:3001>. That is the browser mode and it behaves identically
on every platform.

For the Electron desktop window, ignore `Launch Kyros Studio.vbs` — that is a Windows
script and will not run on a Mac. Its macOS equivalent is:

```bash
KYROS_FORCE_LOCAL=1 REMOTE_URL= npx electron .
```

If Electron complains about the database module, rebuild the native binding for it:

```bash
npm run rebuild:electron
```

Do **not** run `npm run build:exe` — it is hardcoded to a Windows portable target
(`electron-builder --win portable`) and will not produce a Mac app.

## API keys

Keys are **not** put in `.env`. Start the app, then add them in the UI under the API
Keys page. They are encrypted at rest. You need your own keys — Muapi (video
generation, this is the one that costs money per clip), Gemini / Google AI Studio
(image generation and text), and WaveSpeed. Nobody's keys are in this repo.

## What you are working on

Kyros has per-person workspaces, switched from the tab bar at the top. **Eddy's
workspace is the one that matters to you** — Seedream for images, Seedance for
video. The workspaces share all the same code; only the theme and which engines
are exposed differ per tab. Look at `client/src/lib/workspace.js` for how that
works before you change any page — a CSS rule written outside a
`:root[data-workspace="..."]` block hits every tab, not just the one you meant.

## House rules

1. **`client/dist` is committed to this repo.** Run `npm run build:client` before you
   commit, or the app people actually run will not have your change in it.
2. **Restart the server after touching anything in `server/`.** The client hot-reloads,
   the backend does not. Most "my fix did nothing" reports are this.
3. **Video generation costs real money per clip.** Before changing anything that
   touches duration, model choice, or how many images get sent, understand what it
   does to the bill. Duration is what is billed.
4. Verify your work: `npm run verify`, `npm test`, `npm run build:client`.
5. Ask before adding a dependency or restructuring folders.

## Known rough edges (do not "fix" these without asking)

- The Seedance video page opens on 10s / 9:16 / camera-unlocked **on purpose** —
  that is the shape of the content being made. Seedance Omni deliberately keeps
  different defaults because its duration is snapped to a reference clip.
- Video prompts get sanitized before dispatch: a "no music" instruction is appended,
  and any music/audio bullet plus any "avoid overacting" bullet is stripped. Both are
  intentional — the model invents a soundtrack when nothing forbids it, and the
  overacting ban cancels out the facial-performance instructions.
- There is a stray `.mp4` at the repo root from an earlier snapshot. Ignore it.
