# Rules for AI working on Kyros Studio

Point your assistant at this file before it touches anything. Every rule below
comes from a bug that actually happened here, not from general good practice.

---

## 1. Running it

```
npm install
npm run rebuild:electron      # REQUIRED — see below
npm run build:client
npm start
```

**First, run `npm run verify`.** It checks what is actually on disk and tells you
which command fixes what is missing. Do this before diagnosing anything.

**Two different failures look identical** — the app opens to a landing page
because the backend died at startup:

| Symptom on disk | Cause | Fix |
|---|---|---|
| `node_modules/electron/dist/electron.exe` MISSING | install scripts were blocked, so nothing was ever downloaded or compiled | `npm install` (allow install scripts) |
| Electron binary present, `better_sqlite3.node` missing or wrong ABI | built for system Node, not Electron | `npm run rebuild:electron` |

Guessing wrong here costs an hour. **Check the Electron binary exists before
blaming the ABI** — rebuilding native modules cannot fix an install that never
ran. (Reported by a second machine where a fresh clone hit the blocked-scripts
state; this was not observed on the original dev machine.)

**Confirmed on the dev machine:** running the server with system Node fails with
`NODE_MODULE_VERSION 143 vs 137`, because `better-sqlite3` is built for
Electron's ABI. That is a genuine, reproduced error — not the same thing as the
blocked-scripts case above.

**Never test the server with plain `node server/index.js`** — same reason. Use:
```
ELECTRON_RUN_AS_NODE=1 ELECTRON_USER_DATA=<temp dir> \
  ./node_modules/electron/dist/electron.exe server/index.js
```

**The backend port is random.** `electron/main.js` calls `findFreePort()`. It is
not 3001. Read it from the log (`%APPDATA%/ai-content-studio/logs/app.log`)
before concluding the server is down — the log line is
`[electron] startBackendProcess port=NNNNN`.

Verified by reading that log: the running instance was on 18421 while a check
against 3001 reported the backend dead. Note this applies to the **desktop**
build only. Running the server bare (`PORT=… electron … server/index.js`) uses
whatever PORT you set, so a bare-server result does not contradict this.

---

### Environment traps seen on a second machine

Not reproduced on the original dev machine, so treat as machine-specific rather
than universal — but check them before assuming the code is at fault:

- **Node may not be on PATH** in a fresh shell.
- **PowerShell 5.1 has no `&&`.** Use `;` with an `if ($?)` guard, or run the
  commands separately. This also means any npm script chaining with `&&` can
  behave differently there.
- **`client/` needs its own `npm install`** — it is a separate package.
- **`npm run build` in `client/` exited 9 while still producing valid output**
  on that machine, which silently broke the `&&` chain in `build:exe`. It exits
  0 here, so if you see a non-zero exit, check whether `client/dist/index.html`
  is actually fresh before treating it as a failure.

## 2. What a change requires

| Changed | Needed |
|---|---|
| `client/src/**` | `cd client && npm run build`, then Ctrl+R in the app |
| `server/**`, `electron/**` | Full app restart — Ctrl+R does NOT restart the backend |

**`client/dist` is committed on purpose.** The app serves from it. A source edit
without a rebuild ships nothing, and the app keeps running the old code — which
reads as "my fix did nothing". Do not gitignore it.

---

## 3. Verify, do not assert

There is no test framework. A passing build proves almost nothing:

- **A build passing does not mean a page works.** An unreferenced page compiles
  to nothing. Check the chunk actually emits: `ls client/dist/assets | grep -i <Page>`.
- **Vite does not catch undefined JSX identifiers.** They build fine and
  white-screen at runtime.
- **ESLint here has no `eslint-plugin-react`**, so JSX-only components are
  reported as unused. Those warnings are FALSE. Deleting a component on that
  basis broke the app once. Grep for `<ComponentName` first.

To check prompt-building or pure logic, extract the function and run it:
```
node --input-type=module -e "…import the real function…; console.log(fn(args))"
```
That caught three real bugs here that reading could not.

---

## 4. The bug class that keeps recurring: temporal dead zone

Two runtime crashes here were the same shape — a `useMemo`/`useCallback`
dependency array naming a `const` declared **below** it:

```js
const preview = useMemo(() => …, [wantsNude]);   // crashes
const wantsNude = …;                              // declared after
```

Dependency arrays are evaluated during render, so this throws
`Cannot access 'X' before initialization` and the page dies. Sweep before
shipping:

```
python -c "
import re,pathlib
src=pathlib.Path('client/src/pages/YourPage.jsx').read_text(encoding='utf-8')
decl={m.group(1):m.start() for m in re.finditer(r'\n  const (\w+) =',src)}
bad=[n for m in re.finditer(r'\}, \[([^\]]*)\]\);',src) for n in [x.strip() for x in m.group(1).split(',') if x.strip()] if n in decl and decl[n]>m.start()]
print(bad or 'clean')"
```

---

## 5. Prompt engineering rules (Seedream)

The image prompts are built in code, not typed. These are load-bearing:

- **Cancelling instructions produce neither.** A base rule pinning X plus a
  preset changing X leaves the model doing a bad version of both. Every rule that
  can be overridden needs a flag that stands it down — see `wantsNude`,
  `wantsBody`, `undressChip` in `EddyGeneratePage.jsx`.
- **Absolute beats relative.** "She has a LARGE full bust" works; "bigger bust"
  is compared against nothing and dropped.
- **Later statements carry more weight.** A face lock stated early and buried
  under later instructions gets ignored. Restate it after whatever competes.
- **Naming an effect invites it.** "No blur" is weaker than "sharp and in focus,
  edge to edge" plus the ban.
- **Seedream anchors on image 1**, and on any face in any reference. If a
  reference contains a person you do not want, say so explicitly and repeat it.
- **Muapi rejects long prompts** ("The text length cannot exceed the maximum
  limit"); WaveSpeed does not. Seedream runs on WaveSpeed here for that reason.
  If no WaveSpeed key is set it silently falls back to Muapi and every long
  prompt fails — the client warns once per batch.

---

## 6. Money and destructive actions

- **Never spend the user's API credits to test.** Generation costs real money
  per image. Diagnose with the OpenAPI spec, logs, and free endpoints.
- A batch runs to completion with **no stop button**. Batches also stack. Check
  the cost shown on the Generate button before running anything large.
- **Never kill the app to "fix" something** without checking whether a generation
  is in flight — the log shows `seedream5_edit_start` without a matching 200.

---

## 7. Secrets

Read `.claude/skills/pushkyros/SKILL.md` before pushing anything. Short version:

- Never publish `.env`, `_appdata_backup/`, `keys.enc`, `*.db`, `dist-electron/`.
- Never use `--no-verify`. The guard exists because two real leaks were caught
  here, one of them the entire production `.env` pasted into `CLAUDE.md`.
- `ENCRYPTION_SECRET` decrypts every stored API key. **Never rotate it on a
  machine that already has keys saved** — they become unreadable and it looks
  exactly like they were wiped.
