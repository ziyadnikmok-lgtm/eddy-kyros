---
name: pullkyros
description: "Get the other person's Kyros Studio work and make it runnable. Use when the user says pull, get his changes, update from GitHub, sync, or my friend pushed something. Rebuilds the client, never force-pulls, and never auto-resolves a conflict."
---

# pullkyros — take their work without losing yours

Two people work on this repo from two machines, and it publishes through a
**single-commit snapshot branch** (`share-clean`) rather than shared history —
see `.claude/skills/pushkyros/SKILL.md` for why. That shape changes what pulling
means, so read this before reaching for `git pull`.

## First: which clone are you in?

There are two layouts in use, and the right steps differ. Check before anything:

```
git remote -v
git branch
```

**Layout A — snapshot-only clone.** One remote (`origin`), one branch
(`share-clean`), no local `main`. This is what `git clone -b share-clean` gives
you. You have no separate local history to protect, so a pull is an ordinary
fast-forward and most of the ceremony below does not apply. **Use "Steps —
Layout A".**

**Layout B — full working clone.** A local `main` holding your own history plus a
remote (often named `friend`) carrying the snapshot. Here `main` is never pushed
and never pulled, so a pull means "read their snapshot and take what I want",
not "merge our branches" — the snapshot has no common ancestor with your work.
**Use "Steps — Layout B".**

If the commands below name a ref you do not have (`friend`, `main`), you are in
the other layout. Do not invent a substitute — switch sections.

## What you are pulling

| Branch | What it holds |
|---|---|
| `main` | YOUR local history (Layout B only). Never pushed, never pulled. |
| `share-clean` | A snapshot of whoever published last. |

## Absolute rules

1. **NEVER `git pull` while your work is uncommitted.** Commit or stash first.
   A half-finished edit plus an incoming snapshot is how work disappears.
2. **NEVER force-pull, `git reset --hard` onto their branch, or `git checkout
   --theirs` to make a conflict go away.** Losing someone's work silently is the
   exact failure this setup exists to prevent.
3. **NEVER merge `share-clean` into `main`** (Layout B). No common ancestor. Read
   the diff and apply what you want instead — see Layout B step 4. In Layout A
   there is no `main`, so this does not arise.
4. **Never pull secrets back in.** The snapshot should carry no `.env`, no
   `*.db`, no `keys.enc`, no `_appdata_backup/`. If it does, stop and say so:
   something went wrong on their side and the guard needs looking at.

## Steps — Layout A (snapshot-only clone)

**1. Make sure your own work is safe first.**
```
git status --porcelain
```
Anything listed → commit it before going further. Rule 1 still applies: never
pull over uncommitted work.

**2. Fetch and see what is coming.**
```
git fetch origin
git log --oneline HEAD..origin/share-clean
git diff --stat HEAD origin/share-clean -- . ':!client/dist'
```
Empty output from the middle command means there is nothing new.

**3. Pull.**
```
git pull origin share-clean
```
This fast-forwards. If git instead reports a **non-fast-forward / divergent
branches**, stop — they republished as a fresh commit with no shared ancestor.
Do not force, do not reset. Tell the human what diverged.

If the pull is refused over `client/dist` local changes, that is your own build
output colliding with theirs. It is derived, so discard just that directory and
rebuild in step 4:
```
git checkout -- client/dist
git clean -fd client/dist
git pull origin share-clean
```
Never do this to `client/src`.

**4. Rebuild and reinstall as needed** — same as Layout B steps 5–7 below:
rebuild the client, reinstall + `rebuild:electron` if `package.json` changed,
restart properly. Then confirm the install is sound:
```
npm run verify
```

Nothing to commit afterwards — the pull already moved your branch.

## Steps — Layout B (full working clone)

**1. Make sure your own work is safe first.**
```
git status --porcelain
```
Anything listed → commit it on `main` before going further. This is not optional.

**2. Fetch. Do not merge yet.**
```
git fetch friend
git log --oneline friend/share-clean -1
```
That is their latest snapshot. One commit, so the message is the only summary you
get — read it.

**3. See what actually differs.**
```
git diff --stat main friend/share-clean -- . ':!client/dist'
```
`client/dist` is committed build output and will always differ noisily; exclude it
while reading, then rebuild yourself in step 5.

**4. Take what you want, deliberately.**

For a whole file they own:
```
git checkout friend/share-clean -- path/to/file.js
```
For a mixed file, read the diff and apply by hand:
```
git diff main friend/share-clean -- path/to/file.js
```
Do NOT bulk-checkout everything unless you know your own `main` has nothing they
would clobber. When in doubt, check file by file and ask the human.

**5. Rebuild the client. This is not optional.**
```
cd client && npm run build
```
The app serves from `client/dist`, so pulling source without rebuilding leaves you
running the old code and wondering why their change did nothing.

**6. If `package.json` changed, reinstall and rebuild native modules.**
```
npm install
npm run rebuild:electron
```
Then confirm the install is sound — this checks the Electron binary, the
`better-sqlite3` binding, sharp, and the client build in one shot:
```
npm run verify
```

`better-sqlite3` is compiled against Electron's ABI. Skipping the rebuild kills the
backend at startup with a `NODE_MODULE_VERSION` mismatch, which looks like a login
bug and is not one.

**7. Restart properly.**
- Client-only changes → Ctrl+R in the app.
- Anything under `server/` or `electron/` → **fully quit and reopen**. Ctrl+R does
  not restart the backend.

**8. Commit what you took, on `main`.**
```
git add <the files you deliberately took>
git commit -m "pull: take <what> from friend/share-clean"
```
Say in the message that it came from their snapshot. Six months from now that is
the only record of where the change originated.

## Conflicts

If a file you both changed needs merging, **stop and tell the human what
conflicts.** Never auto-resolve, never pick a side, never `--ours`/`--theirs` to
make it quiet. Show both versions and let them decide.

## After pulling

Their snapshot may include collection exports (`eddy-pose.json`,
`eddy-outfit.json`). Those are **not** applied by pulling — they are imported in
the app: Eddy · Pose or Outfit → **Choose file**. Importing adds to what you have
rather than replacing it, so re-importing the same file twice gives you duplicates.
