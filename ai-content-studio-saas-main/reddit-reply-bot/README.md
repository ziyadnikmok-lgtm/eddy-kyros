# Reddit Post Studio

Standalone Electron app for planning safe Reddit self-post drafts on a schedule with local memory, subreddit routing, and manual approval.

## What It Supports

- Multiple Reddit account plans via pasted browser cookies
- Subreddit targets such as `r/Entrepreneur` or full subreddit URLs
- Single Draft mode for one safe test draft
- Continuous schedule mode with strict Reddit-safe pacing
- Per-target tone, notes, and posting-account routing
- Local draft memory to avoid repetitive output
- Gemini-powered draft generation with a safe local fallback

## Posting Limits

- Daily max: 5 planned drafts per account
- Hourly max: 2 planned drafts per account
- Default cadence: 1 draft every 30 minutes
- Per subreddit: 24 hour cooldown
- Same image/media key: 60 minute cooldown before another subreddit

## Local Files

- `accounts.json`: safe starter template
- `accounts.local.json`: saved local settings and account plans
- `watch-state.json`: safe starter state
- `watch-state.local.json`: local draft memory

## Start

```bash
npm install
npm start
```

Inside this parent workspace, the app can also reuse the already-installed Electron and Playwright packages.

## Cookies

Paste exported Reddit cookies from your browser in either:

- JSON array format from a cookie extension
- `name=value; name=value` format

Cookies are currently stored as account plans for routing and future live-post support. The safe draft planner itself does not need a live Reddit login.

To connect an account:

1. Log into Reddit in your browser.
2. Export cookies for `reddit.com` with a browser cookie extension.
3. Add an account in the app and paste the full JSON cookie export.
4. Mark the account as Active or route specific subreddit targets to it.

## Notes

- This build focuses on safe subreddit post drafts, not automated replies.
- Unsafe or explicit subreddit targets are skipped automatically.
- Each generated draft is manual-submit only from the Draft Queue.
- Bulk target paste is included so Airtable exports can be dropped in later as newline-separated subreddit values.
