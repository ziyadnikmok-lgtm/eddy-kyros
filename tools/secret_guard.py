#!/usr/bin/env python
"""Kyros secret guard — refuses to let credentials or user data reach GitHub.

This repo is one `git push` away from being a very bad day:

  * `saas.db` holds 27 real user accounts — emails, password hashes, subscriptions.
  * `keys.enc` is every API key anyone has saved, encrypted with ENCRYPTION_SECRET.
  * `.env` and `_appdata_backup/.env` hold that ENCRYPTION_SECRET. Together with
    keys.enc that is the whole set: the file and the key to open it.
  * The repo is shared with a second person, so "only I can see it" is not true.

Git history is permanent. Deleting a secret in a later commit does not remove it
from the history that gets published. This runs before the commit AND again
before the push, because pre-commit can be skipped with --no-verify and older
commits carry no proof they were ever checked.

Usage:
    secret_guard.py --staged            # pre-commit
    secret_guard.py --range BASE..HEAD  # pre-push
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

# Paths that must never be published, whatever .gitignore claims. .gitignore is
# not evidence: `.env` sat in it and was tracked anyway for months.
BACKSLASH = chr(92)

BANNED_PATHS = [
    re.compile(r'(^|/)\.env($|\.)'),          # .env, .env.local, .env.production
    re.compile(r'^_appdata_backup/'),         # full AppData copy: secrets + keys.enc + db
    re.compile(r'(^|/)keys\.enc$'),           # encrypted API keys
    re.compile(r'\.(db|sqlite3?)$'),          # saas.db — real user accounts
    re.compile(r'(^|/)secrets?\.json$'),
    re.compile(r'\.(pem|pfx|p12|key)$'),
    re.compile(r'(^|/)service-account.*\.json$'),
    re.compile(r'^dist-electron/'),           # 126 MB build output
    re.compile(r'^userdata/'),
]

# `.env.example` is the whole point of an example file.
ALLOW_PATHS = [
    re.compile(r'(^|/)\.env\.example$'),
]

# Live credentials, matched on content. Named so the message says what was found.
SECRET_PATTERNS = [
    ('WaveSpeed API key', re.compile(rb'wsk_live_[A-Za-z0-9_\-]{16,}')),
    ('OpenAI-style key', re.compile(rb'sk-[A-Za-z0-9]{32,}')),
    ('Resend API key', re.compile(rb're_[A-Za-z0-9]{8,12}_[A-Za-z0-9]{20,}')),
    ('Google API key', re.compile(rb'AIza[0-9A-Za-z_\-]{30,}')),
    ('private key block', re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('AWS access key', re.compile(rb'AKIA[0-9A-Z]{16}')),
    # A 64-char hex assignment is what ENCRYPTION_SECRET / SESSION_SECRET look like.
    ('64-char hex secret', re.compile(rb'(?i)(secret|key|token)\s*[=:]\s*["\']?[0-9a-f]{64}')),
]


def run(args: list[str]) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=False).stdout


def staged_files() -> list[str]:
    out = run(['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    return [f for f in out.splitlines() if f.strip()]


def range_pairs(rev_range: str) -> list:
    """Every (commit, path) touched anywhere in the range — not the endpoint diff.

    A push uploads every object reachable from the commits being sent, including
    blobs for files a later commit deleted. `git diff BASE..HEAD` cannot see
    those: added-then-deleted nets out to nothing. That is exactly how a full
    AppData backup holding ENCRYPTION_SECRET and keys.enc sat inside this range
    while the endpoint diff looked clean.
    """
    out = run(['git', 'log', '--pretty=format:%H', '--name-only',
               '--diff-filter=ACMR', rev_range])
    pairs = []
    commit = ''
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) == 40 and all(c in '0123456789abcdef' for c in line):
            commit = line
        elif commit:
            pairs.append((commit, line))
    return pairs


def blob(ref: str, path: str) -> bytes:
    """Read the exact version being published, not what happens to be on disk."""
    src = f':{path}' if ref == ':' else f'{ref}:{path}'
    proc = subprocess.run(['git', 'show', src], capture_output=True, check=False)
    return proc.stdout if proc.returncode == 0 else b''


def check(pairs) -> list:
    """pairs: (ref, path). ref is ":" for the staged index, else a commit sha."""
    problems = []
    seen = set()
    for ref, path in pairs:
        norm = path.replace(BACKSLASH, "/")
        if any(p.search(norm) for p in ALLOW_PATHS):
            continue
        if any(p.search(norm) for p in BANNED_PATHS):
            if ("path", norm) not in seen:
                seen.add(("path", norm))
                problems.append(f"{path}\n    banned path - this file must never be published")
            continue

        key = (ref, norm)
        if key in seen:
            continue
        seen.add(key)

        data = blob(ref, path)
        if not data or b"\x00" in data[:8000]:      # binary: nothing useful to scan
            continue
        for label, pattern in SECRET_PATTERNS:
            hit = pattern.search(data)
            if hit:
                sample = hit.group(0)[:12].decode("utf-8", "replace")
                where = "" if ref == ":" else f" in {ref[:8]}"
                problems.append(f'{path}{where}\n    contains a {label} (starts "{sample}")')
                break
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--staged', action='store_true')
    ap.add_argument('--range')
    args = ap.parse_args()

    if args.staged:
        pairs = [(':', f) for f in staged_files()]
    else:
        pairs = range_pairs(args.range or 'HEAD')
    problems = check(pairs)
    if not problems:
        return 0

    where = 'COMMIT' if args.staged else 'PUSH'
    print(f'\n{where} REFUSED — Kyros secret guard\n', file=sys.stderr)
    for p in problems:
        print(f'  {p}', file=sys.stderr)
    print(
        '\nNothing here is safe to publish. Unstage the file rather than working'
        '\naround the guard — --no-verify exists to skip this check, which is'
        '\nexactly why you should not reach for it.\n'
        '\nIf you are certain it is a false positive, show a human the message and'
        '\nlet them decide. Widening the allowlist is its own separate commit.\n',
        file=sys.stderr,
    )
    return 1


if __name__ == '__main__':
    sys.exit(main())
