---
description: Kyros Studio project workflow — folder rules, testing, and GitHub push protocol
---

# Kyros Studio Project Workflow

## Folder Roles

| Folder | Role |
|---|---|
| `/Users/admin/ai-content-studio-saas-main` | ✅ Active working folder — all edits happen here |
| `/Users/admin/copy kyros` | 🔒 Personal backup only — never push from here |
| `/Users/admin/ai-content-studio-saas-upstream` | 🚀 Clean GitHub-connected push folder |

## Rules

1. **All changes and edits** must be made in `ai-content-studio-saas-main`
2. **Never push** anything until the user explicitly says to push
3. **Never use** `copy kyros` for pushing — it is a read-only personal backup
4. **When the user approves a push:**
   - Copy the exact approved changes into `ai-content-studio-saas-upstream`
   - Run `git add`, `git commit`, and `git push` from `ai-content-studio-saas-upstream`

## Local App Testing

- Always test from **source**, not from the packaged app
- The packaged `/Applications/Kyros Studio.app` is unreliable — avoid it
- Run the Electron app from the main project folder:

```bash
cd /Users/admin/ai-content-studio-saas-main
node electron/launch.js
```

## Current Goal

- Keep the running job UI visible if the user leaves a tool page and returns
- Do local Electron app testing first
- Push to GitHub only after the user confirms it works

## Push Checklist

- [ ] Changes made and tested in `ai-content-studio-saas-main`
- [ ] User confirms the feature works locally
- [ ] User explicitly says "push" or approves the push
- [ ] Sync approved changes to `ai-content-studio-saas-upstream`
- [ ] `git add .` from `ai-content-studio-saas-upstream`
- [ ] `git commit -m "[descriptive message]"` from `ai-content-studio-saas-upstream`
- [ ] `git push` from `ai-content-studio-saas-upstream`
