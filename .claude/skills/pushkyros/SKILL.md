---
name: pushkyros
description: "Safely publish Kyros Studio work to the shared GitHub branch. Use when the user says push, publish, send it to my friend, share the code, or upload. Enforces the secret guard, keeps history out of the published branch, rebuilds client/dist first, and never force-pushes."
---

# pushkyros — publish work without publishing secrets

This repo is one careless push from a very bad day. Before anything else,
understand what lives here:

- **`saas.db` holds 27 real user accounts** — emails, password hashes,
  subscriptions. Not test rows. Real people.
- **`keys.enc`** is every API key anyone saved, encrypted with `ENCRYPTION_SECRET`.
- **`.env` and `_appdata_backup/.env` hold that `ENCRYPTION_SECRET`.** File plus
  key to open it, in the same repo.
- **The remote is shared with a second person.** "Only I can see it" is false.

**Git history is permanent.** Deleting a secret in a later commit does not remove
it from the history a push publishes. Two separate incidents were caught here by
reading carefully, not by luck: `CLAUDE.md` contained the live production `.env`
(encryption secret, session secret, Resend key, admin password), and
`_appdata_backup/` sat in history holding `ENCRYPTION_SECRET` alongside
`keys.enc`.

## Absolute rules

1. **NEVER `--no-verify`.** That flag exists to skip the secret guard. Wanting it
   is the guard working. Stop instead.
2. **NEVER `git push --force` / `--force-with-lease`.** It destroys the other
   person's commits.
3. **NEVER push `main` to the shared remote.** `main` carries the history
   described above. Only the snapshot branch is safe to publish — see below.
4. **THE RULE: share CODE, never DATA.** Never publish, whatever `.gitignore`
   claims: `.env`, `.env.*`, `_appdata_backup/`, `keys.enc`, `*.db`, `*.sqlite`,
   `dist-electron/`, `userdata/`, `*.pem`, service-account JSON.
5. **`.gitignore` is not evidence.** `.env` was listed in it and tracked anyway
   for months — a rule never applies to a file already tracked. Verify what is
   **staged**, never assume.
6. **`client/dist` IS committed here, on purpose.** The app serves from it, so a
   source change without a rebuild ships nothing. This is the opposite of the
   usual advice — do not "helpfully" gitignore it.

## The two-branch model

| Branch | What it is | Push it? |
|---|---|---|
| `main` | Full local history, including old commits with secrets | **Never** |
| `share-clean` | A single commit of the current working tree, no history | Yes |

The snapshot exists because a push uploads every object reachable from the
commits being sent — including blobs for files a later commit deleted. Removing
`_appdata_backup` today does not make pushing `main` safe tomorrow.

## Steps

**1. Confirm the guard is installed. If it is not, stop.**
```
git config --get core.hooksPath
```
Must print `tools/hooks`. If it prints nothing:
```
git config core.hooksPath tools/hooks
```

**2. Rebuild the client if any `client/src` file changed.**
```
cd client && npm run build
```
A source change without this publishes stale assets, and the app serves `dist`.
A build failure is a real failure — never commit past one.

**3. Commit your work on `main` as normal.** The pre-commit guard runs here.

**4. Refresh the snapshot branch from `main`'s tree.**
```
git checkout share-clean
git checkout main -- .
git add -A -- . ':!nul' ':!.git-rewrite'
```

**5. Read back what is staged. This is the important step.**
```
git diff --cached --name-only
```
Look at every line. Anything you did not deliberately intend to publish, unstage:
`git restore --staged <file>`.

**6. Run the guard by hand before committing.**
```
python tools/secret_guard.py --staged
```
Silence means clean. If it refuses, read the finding — it names the file and why.

**7. Commit and push the snapshot only.**
```
git commit -m "Kyros Studio — shareable snapshot (refresh)"
git push friend share-clean:share-clean
```
If the transfer dies with `unexpected disconnect while reading sideband packet`,
that is size, not rejection: `git config http.postBuffer 524288000` and retry.
Do not force.

**8. Verify it landed. Do not just claim it.**
```
git ls-remote friend share-clean
```
The hash must match `git rev-parse share-clean`.

**9. Return to main.**
```
git checkout main
```

## If the guard refuses

It printed the file and the reason. **Do not work around it.**

- A secret genuinely got staged → unstage it. The guard just saved an account.
- You believe it is a false positive → **show the human and let them decide.**

A real false positive was found here: the pattern `re_[A-Za-z0-9_-]{16,}` matched
`re_filter_and…` in minified client code. The fix was tightening the pattern to
the real Resend key shape, **not** allowlisting the file. A guard that fires on
every legitimate push is a guard people learn to bypass — that is how it fails.

Widening the allowlist is its own deliberate commit, never bundled with work.

## Things that look like bugs and are not

- **`better-sqlite3` fails under plain `node`** with a `NODE_MODULE_VERSION`
  mismatch. It is compiled for Electron's ABI. Test the server with
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe server/index.js`,
  never `node server/index.js`.
- **The backend port is random** (`findFreePort()`), not 3001. Read it from the
  Electron log before concluding the server is dead. That mistake was made here.
