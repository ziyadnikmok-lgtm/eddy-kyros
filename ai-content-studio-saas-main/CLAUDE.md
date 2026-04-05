# AI Content Studio

## Session Rules — Read This First Every Session

### Build & Test Workflow
1. Make code changes in `client/src/`
2. Build: `cd client && npm run build`
3. Restart app: `pkill -f "Kyros Studio" 2>/dev/null; pkill -f "electron" 2>/dev/null; sleep 1 && open "/Users/admin/Kyros Studio Local.command"`
4. Tell user "App is restarted, ready to test"
5. Wait for user to test and approve before pushing to GitHub

### NEVER push automatically
- Only push when user explicitly says "push to GitHub"
- Always confirm the repo before pushing: `github.com/velinus77/ai-content-studio-saas` (branch: `main`)
- Pull rebase first if remote is ahead: `git pull --rebase origin main`
- Only stage the specific files changed, never `git add .`

### Kyros Studio App
- Launch: `/Users/admin/Kyros Studio Local.command`
- Electron runs on: `http://127.0.0.1:18421`
- Login: `rekyx2@gmail.com` / `Orly123$`
- Client source: `client/src/` — must build after every change
- Built output served from: `client/dist/`

### Browsing & QA
- Use `/browse` (gstack) to test the live app at `127.0.0.1:18421`
- Use `/qa` for a full QA pass
- Use `/gstack` for headless browser tasks
- Never use `mcp__claude-in-chrome__*` tools
- If session expired, re-login via the Sign In modal

---

## gstack Skills

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

### Available gstack skills
- `/browse` — Test the live app, QA, web browsing
- `/gstack` — Headless browser tasks
- `/qa` — Full QA pass on the app
- `/qa-only` — QA report only, no fixes
- `/review` — Code review before pushing
- `/ship` — Ship + PR workflow
- `/design-review` — Visual/design audit
- `/plan-ceo-review` — CEO-perspective plan review
- `/plan-eng-review` — Engineering plan review
- `/plan-design-review` — Design plan review
- `/design-consultation` — Design consultation
- `/qa-design-review` — QA + design review
- `/setup-browser-cookies` — Set up browser cookies
- `/retro` — Retrospective
- `/document-release` — Document a release
