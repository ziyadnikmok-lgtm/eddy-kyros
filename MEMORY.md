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
- Daily automation configured:
  - 10 runs/day (10-minute spacing) via two cron jobs in Asia/Bangkok:
    - `b3058028-9070-4a65-baf6-9485d6e11adb` (09:00–09:50)
    - `c31705b8-4d7e-4c1b-bf67-5d9fc69c5859` (10:00–10:30)
  - Task: find high-engagement OF creator post, analyze caption, reply with one image from `/Users/admin/Downloads/IG POST SOFIA`, return links/caption.
