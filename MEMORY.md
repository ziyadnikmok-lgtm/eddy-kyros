# MEMORY.md

## Durable Preferences

- When I learn something useful/new, I should record it immediately so it persists across sessions.
- Prefer storing short-term chronology in `memory/YYYY-MM-DD.md` and long-term stable preferences/decisions in `MEMORY.md`.

## Environment Notes

- ClamAV installed on 2026-02-26 (`clamscan` available, v1.5.1).
- Browser-control reliability runbook:
  - If Chrome relay fails with `invalid request frame` / handshake errors, do not loop retries.
  - Check gateway health first (`openclaw gateway status`, `openclaw status --deep`, recent logs).
  - Ensure persistent service is installed+running (`openclaw gateway install`, `openclaw gateway start`).
  - Prefer `browser profile=openclaw` as stable fallback when relay is flaky.
  - Re-check with `browser status/tabs` before user-facing claims.
- User prefers: when any new fix/lesson is learned, save it to memory immediately and consult memory first during troubleshooting.
- X posting runbook (fast + reliable):
  - Prefer `browser profile=openclaw` for posting when relay is unstable.
  - Use `browser upload` with `inputRef` on the compose "Choose File" control when needed.
  - After upload, verify media block appears and Post button is enabled.
  - If click ref gets stale, use `act kind=evaluate` to click enabled Post button by text.
  - Confirm success by checking toast "Your post was sent" and capturing resulting status URL.
  - Dashboard now supports direct image upload into `/Users/admin/Downloads/IG POST SOFIA` via local API (`dashboard_server.py`, endpoints `/api/upload-images` and `/api/list-images`).
  - If dashboard server crashes with `ModuleNotFoundError: cgi`, use JSON/base64 upload path (Python 3.13+ removed `cgi`).
- Daily automation configured:
  - 10 runs/day (10-minute spacing) via two cron jobs in America/New_York:
    - `b3058028-9070-4a65-baf6-9485d6e11adb` (09:00–09:50 NY)
    - `c31705b8-4d7e-4c1b-bf67-5d9fc69c5859` (10:00–10:30 NY)
  - Task now checks priority queue first (`social-reply-queue.json`): if manual URL queued, process that URL immediately; otherwise continue normal tracked-profile flow.
  - Uses `social-reply-config.json` + `social-reply-state.json` for config/state.
